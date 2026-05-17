"""Tests for scripts/redis_file_mirror.py.

The mirror is the bidirectional Redis ↔ ~/WarRoom/ sync. It must:

- Push local-only state into Redis on first run.
- Write redis-only state to disk on first run.
- Stay quiet when nothing changed.
- Propagate one-sided edits in either direction.
- Resolve two-sided edits by ISO timestamp ("last-edit-wins") with a
  WARN log.
- Round-trip HANDOFFS.md via parse → upsert → re-render so byte-level
  drift normalises.
- Walk KnowledgeBase / Skill_Inbox / NotionInbox directories the same
  way as the top-level files.
- Skip all writes when `--dry-run` is set.

All Redis I/O uses `fakeredis`; all filesystem I/O uses `tmp_path`. No
live network, no live filesystem outside the test's tmp directory.
"""

from __future__ import annotations

import importlib.util
import logging
import sys
import time
from pathlib import Path

import fakeredis
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.redis_store import RedisStore  # noqa: E402


MIRROR_PATH = REPO_ROOT / "scripts" / "redis_file_mirror.py"


def _load_mirror(monkeypatch, warroom: Path):
    """Re-import the mirror module with WARROOM_PATH pointed at a tmp dir.

    The module reads WARROOM_PATH at import time, so we have to wipe the
    cached module before each test that needs a fresh warroom root.
    """
    monkeypatch.setenv("WARROOM_PATH", str(warroom))
    for name in list(sys.modules):
        if name == "redis_file_mirror":
            del sys.modules[name]
    spec = importlib.util.spec_from_file_location("redis_file_mirror", MIRROR_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def store() -> RedisStore:
    return RedisStore(client=fakeredis.FakeRedis(decode_responses=True))


@pytest.fixture
def warroom(tmp_path: Path) -> Path:
    root = tmp_path / "WarRoom"
    root.mkdir()
    return root


# ---- Bootstrap: empty redis + populated local ---------------------------


def test_first_run_pushes_local_files_to_redis(monkeypatch, warroom, store):
    mirror = _load_mirror(monkeypatch, warroom)
    (warroom / "CURRENT_STATE.md").write_text("state v1", encoding="utf-8")
    (warroom / "SHARED_MEMORY.md").write_text("mem v1", encoding="utf-8")

    results = mirror.run_once(store, dry_run=False)

    assert store.get_file("CURRENT_STATE.md") == "state v1"
    assert store.get_file("SHARED_MEMORY.md") == "mem v1"
    assert results["files"]["CURRENT_STATE.md"] == "bootstrap_push"
    assert results["files"]["SHARED_MEMORY.md"] == "bootstrap_push"


def test_first_run_seeds_meta_timestamp_for_pushed_files(monkeypatch, warroom, store):
    mirror = _load_mirror(monkeypatch, warroom)
    (warroom / "CURRENT_STATE.md").write_text("hello", encoding="utf-8")
    mirror.run_once(store, dry_run=False)
    assert store.r.get("wr:meta:file:CURRENT_STATE.md:last_updated_at")


# ---- Bootstrap: populated redis + empty local ---------------------------


def test_first_run_writes_redis_files_to_local(monkeypatch, warroom, store):
    mirror = _load_mirror(monkeypatch, warroom)
    store.set_file("CURRENT_STATE.md", "from redis")
    store.set_file("SCHEDULE.md", "schedule body")

    mirror.run_once(store, dry_run=False)

    assert (warroom / "CURRENT_STATE.md").read_text(encoding="utf-8") == "from redis"
    assert (warroom / "SCHEDULE.md").read_text(encoding="utf-8") == "schedule body"


def test_atomic_write_leaves_no_temp_files(monkeypatch, warroom, store):
    mirror = _load_mirror(monkeypatch, warroom)
    store.set_file("CURRENT_STATE.md", "atomic check")
    mirror.run_once(store, dry_run=False)
    leftovers = list(warroom.glob("*.redis_mirror_tmp"))
    assert leftovers == []


# ---- Steady state: unchanged ticks make no I/O --------------------------


def test_unchanged_tick_is_a_noop(monkeypatch, warroom, store):
    mirror = _load_mirror(monkeypatch, warroom)
    store.set_file("CURRENT_STATE.md", "stable")
    mirror.run_once(store, dry_run=False)
    # Capture mtime after the bootstrap write.
    mtime_after_bootstrap = (warroom / "CURRENT_STATE.md").stat().st_mtime

    # Second run, no changes anywhere.
    results = mirror.run_once(store, dry_run=False)

    assert results["files"] == {}
    assert (warroom / "CURRENT_STATE.md").stat().st_mtime == mtime_after_bootstrap


# ---- One-sided edits ----------------------------------------------------


def test_local_edit_propagates_to_redis(monkeypatch, warroom, store):
    mirror = _load_mirror(monkeypatch, warroom)
    (warroom / "CURRENT_STATE.md").write_text("v1", encoding="utf-8")
    mirror.run_once(store, dry_run=False)

    # User edits the file.
    (warroom / "CURRENT_STATE.md").write_text("v2 from local", encoding="utf-8")
    # Bump mtime so the change registers even on coarse filesystems.
    new_time = time.time() + 1
    import os
    os.utime(warroom / "CURRENT_STATE.md", (new_time, new_time))

    results = mirror.run_once(store, dry_run=False)
    assert results["files"]["CURRENT_STATE.md"] == "push_local_to_redis"
    assert store.get_file("CURRENT_STATE.md") == "v2 from local"


def test_redis_edit_propagates_to_local(monkeypatch, warroom, store):
    mirror = _load_mirror(monkeypatch, warroom)
    store.set_file("CURRENT_STATE.md", "v1")
    mirror.run_once(store, dry_run=False)

    # Another process writes a new value to Redis.
    store.set_file("CURRENT_STATE.md", "v2 from redis")

    results = mirror.run_once(store, dry_run=False)
    assert results["files"]["CURRENT_STATE.md"] == "write_redis_to_local"
    assert (warroom / "CURRENT_STATE.md").read_text(encoding="utf-8") == "v2 from redis"
    # No stray temp files.
    assert list(warroom.glob("*.redis_mirror_tmp")) == []


# ---- Two-sided conflict -------------------------------------------------


def test_both_change_newer_local_wins_with_warning(monkeypatch, warroom, store, caplog):
    mirror = _load_mirror(monkeypatch, warroom)
    (warroom / "CURRENT_STATE.md").write_text("v1", encoding="utf-8")
    mirror.run_once(store, dry_run=False)

    # Redis was edited (with a stale meta timestamp).
    store.set_file("CURRENT_STATE.md", "redis says X")
    store.r.set(
        "wr:meta:file:CURRENT_STATE.md:last_updated_at",
        "2000-01-01T00:00:00Z",
    )
    # Local was edited more recently (current epoch >> year 2000).
    (warroom / "CURRENT_STATE.md").write_text("local says Y", encoding="utf-8")
    now = time.time()
    import os
    os.utime(warroom / "CURRENT_STATE.md", (now, now))

    with caplog.at_level(logging.WARNING, logger="redis_file_mirror"):
        results = mirror.run_once(store, dry_run=False)

    assert results["files"]["CURRENT_STATE.md"] == "conflict_local_wins"
    assert store.get_file("CURRENT_STATE.md") == "local says Y"
    assert any("both sides changed" in r.message for r in caplog.records)


def test_both_change_newer_redis_wins(monkeypatch, warroom, store):
    mirror = _load_mirror(monkeypatch, warroom)
    (warroom / "CURRENT_STATE.md").write_text("v1", encoding="utf-8")
    mirror.run_once(store, dry_run=False)

    # Local was edited a long time ago.
    import os
    old = time.time() - 10_000_000
    (warroom / "CURRENT_STATE.md").write_text("ancient local", encoding="utf-8")
    os.utime(warroom / "CURRENT_STATE.md", (old, old))

    # Redis was just edited; meta timestamp = now.
    store.set_file("CURRENT_STATE.md", "fresh redis")
    from datetime import datetime, timezone
    store.r.set(
        "wr:meta:file:CURRENT_STATE.md:last_updated_at",
        datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )

    results = mirror.run_once(store, dry_run=False)
    assert results["files"]["CURRENT_STATE.md"] == "conflict_redis_wins"
    assert (warroom / "CURRENT_STATE.md").read_text(encoding="utf-8") == "fresh redis"


# ---- HANDOFFS.md round-trip --------------------------------------------


_SAMPLE_HANDOFFS_MD = """
- Task: Inspect health [wrb_aaaaaaaaaaaa]
  Owner: Hermes
  Files Touched: /wr/**
  Status: PENDING
  Result:
  Next Action: Review inbox
"""


def test_handoffs_local_write_parses_into_redis(monkeypatch, warroom, store):
    mirror = _load_mirror(monkeypatch, warroom)
    (warroom / "HANDOFFS.md").write_text(_SAMPLE_HANDOFFS_MD, encoding="utf-8")
    mirror.run_once(store, dry_run=False)
    h = store.get_handoff("wrb_aaaaaaaaaaaa")
    assert h is not None
    assert h["task"].startswith("Inspect health")
    assert h["owner"] == "Hermes"
    assert h["status"] == "PENDING"


def test_handoffs_round_trip_is_stable(monkeypatch, warroom, store):
    """Write → parse → re-render → second tick must be a no-op."""
    mirror = _load_mirror(monkeypatch, warroom)
    (warroom / "HANDOFFS.md").write_text(_SAMPLE_HANDOFFS_MD, encoding="utf-8")
    mirror.run_once(store, dry_run=False)
    after_first = (warroom / "HANDOFFS.md").read_text(encoding="utf-8")

    results = mirror.run_once(store, dry_run=False)
    after_second = (warroom / "HANDOFFS.md").read_text(encoding="utf-8")

    assert after_first == after_second
    # Second tick should report no handoff change.
    assert results["handoffs"] == {}


def test_handoffs_redis_only_renders_to_disk(monkeypatch, warroom, store):
    mirror = _load_mirror(monkeypatch, warroom)
    store.upsert_handoff(
        "wrb_aaaaaaaaaaaa",
        task="From redis",
        owner="OpenClaw",
        files_touched="/wr/**",
        status="COMPLETED",
        result="ok",
        next_action="none",
    )
    mirror.run_once(store, dry_run=False)
    text = (warroom / "HANDOFFS.md").read_text(encoding="utf-8")
    assert "From redis" in text
    assert "wrb_aaaaaaaaaaaa" in text
    assert "Status: COMPLETED" in text


# ---- KnowledgeBase ------------------------------------------------------


def test_kb_local_md_pushes_to_redis(monkeypatch, warroom, store):
    mirror = _load_mirror(monkeypatch, warroom)
    kb = warroom / "KnowledgeBase"
    (kb / "guides").mkdir(parents=True)
    (kb / "intro.md").write_text("intro body", encoding="utf-8")
    (kb / "guides" / "onboarding.md").write_text("ob body", encoding="utf-8")

    mirror.run_once(store, dry_run=False)

    assert store.get_kb_doc("intro.md") == "intro body"
    assert store.get_kb_doc("guides/onboarding.md") == "ob body"
    assert set(store.list_kb_docs()) == {"intro.md", "guides/onboarding.md"}


def test_kb_redis_only_writes_to_disk(monkeypatch, warroom, store):
    mirror = _load_mirror(monkeypatch, warroom)
    store.set_kb_doc("snippets/python.md", "py tips")

    mirror.run_once(store, dry_run=False)

    written = warroom / "KnowledgeBase" / "snippets" / "python.md"
    assert written.exists()
    assert written.read_text(encoding="utf-8") == "py tips"


# ---- Skill Inbox --------------------------------------------------------


def test_skill_local_pushes_to_redis(monkeypatch, warroom, store):
    mirror = _load_mirror(monkeypatch, warroom)
    skills = warroom / "Skill_Inbox"
    skills.mkdir()
    (skills / "daily-digest.md").write_text("the skill text", encoding="utf-8")

    mirror.run_once(store, dry_run=False)

    assert store.get_skill("daily-digest.md") == "the skill text"


def test_skill_redis_only_writes_to_disk(monkeypatch, warroom, store):
    mirror = _load_mirror(monkeypatch, warroom)
    store.set_skill("weekly-report.md", "weekly skill")

    mirror.run_once(store, dry_run=False)

    written = warroom / "Skill_Inbox" / "weekly-report.md"
    assert written.exists()
    assert written.read_text(encoding="utf-8") == "weekly skill"


# ---- Notion inbox -------------------------------------------------------


def test_notion_inbox_local_pushes_to_redis(monkeypatch, warroom, store):
    mirror = _load_mirror(monkeypatch, warroom)
    inbox = warroom / "NotionInbox"
    inbox.mkdir()
    (inbox / "wrb_aaaaaaaaaaaa.md").write_text("snapshot body", encoding="utf-8")

    mirror.run_once(store, dry_run=False)

    assert store.get_notion_inbox("wrb_aaaaaaaaaaaa") == "snapshot body"


def test_notion_inbox_redis_only_writes_to_disk(monkeypatch, warroom, store):
    mirror = _load_mirror(monkeypatch, warroom)
    store.set_notion_inbox("wrb_bbbbbbbbbbbb", "from redis")
    mirror.run_once(store, dry_run=False)
    p = warroom / "NotionInbox" / "wrb_bbbbbbbbbbbb.md"
    assert p.exists() and p.read_text(encoding="utf-8") == "from redis"


# ---- Dry-run mode -------------------------------------------------------


def test_dry_run_does_not_write_to_redis_or_disk(monkeypatch, warroom, store):
    """In --dry-run the mirror must announce actions but not persist them.

    We monkeypatch the mutating Redis methods to record any calls. The
    atomic-write helper itself respects `dry_run` internally, so we
    verify the on-disk side by checking that the file Redis "owns"
    never appeared on disk.
    """
    mirror = _load_mirror(monkeypatch, warroom)
    (warroom / "CURRENT_STATE.md").write_text("local v1", encoding="utf-8")
    store.set_file("SCHEDULE.md", "redis schedule")

    set_file_called = []
    monkeypatch.setattr(store, "set_file", lambda *a, **kw: set_file_called.append(a))

    results = mirror.run_once(store, dry_run=True)

    # Dry-run should still report what it would do.
    assert results["files"]["CURRENT_STATE.md"] == "bootstrap_push"
    assert results["files"]["SCHEDULE.md"] == "bootstrap_write"
    # Redis was not mutated (push path).
    assert set_file_called == []
    # Disk was not mutated (write path): SCHEDULE.md should still be
    # absent because we never let the redis text touch disk.
    assert not (warroom / "SCHEDULE.md").exists()
    # Sidecar must not be written either.
    assert not (warroom / ".redis_file_mirror_state.json").exists()


def test_dry_run_handoffs_does_not_upsert(monkeypatch, warroom, store):
    mirror = _load_mirror(monkeypatch, warroom)
    (warroom / "HANDOFFS.md").write_text(_SAMPLE_HANDOFFS_MD, encoding="utf-8")
    upsert_called = []
    monkeypatch.setattr(
        store, "upsert_handoff",
        lambda *a, **kw: upsert_called.append((a, kw)),
    )
    mirror.run_once(store, dry_run=True)
    assert upsert_called == []
    assert store.get_handoff("wrb_aaaaaaaaaaaa") is None
