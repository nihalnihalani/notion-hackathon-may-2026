"""Tests for scripts/migrate_local_to_redis.py.

Exercises the per-scope migration helpers against a fakeredis-backed
RedisStore and a tmp_path "WarRoom" directory.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import fakeredis
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "scripts" / "migrate_local_to_redis.py"


def _load_script():
    """Import the migration script as a module."""
    for name in list(sys.modules):
        if name == "migrate_local_to_redis":
            del sys.modules[name]
    spec = importlib.util.spec_from_file_location(
        "migrate_local_to_redis", SCRIPT_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def store():
    sys.path.insert(0, str(REPO_ROOT))
    from src.redis_store import RedisStore
    return RedisStore(client=fakeredis.FakeRedis(decode_responses=True))


@pytest.fixture
def warroom(tmp_path):
    (tmp_path / "KnowledgeBase").mkdir()
    (tmp_path / "Skill_Inbox").mkdir()
    (tmp_path / "NotionInbox").mkdir()
    return tmp_path


# ---- _migrate_bridge_state ------------------------------------------------


def test_migrate_bridge_state_copies_full_json(store, warroom):
    mod = _load_script()
    state = {
        "version": 1,
        "command_center_data_source_id": "ds_xyz",
        "dashboard_block_id": "blk_dash",
        "pages": {"page_a": {"handoff_key": "wrb_aaaaaaaaaaaa"}},
        "mission_control_pages": {"live_state": {"page_id": "p1", "block_id": "b1"}},
        "openclaw_pages": {"screen_tasks": {"page_id": "p2"}},
    }
    (warroom / ".notion_bridge_state.json").write_text(json.dumps(state), "utf-8")

    n = mod._migrate_bridge_state(store, warroom, dry_run=False)

    assert n == 1
    assert store.get_bridge_state() == state


def test_migrate_bridge_state_skips_when_file_missing(store, warroom):
    mod = _load_script()
    n = mod._migrate_bridge_state(store, warroom, dry_run=False)
    assert n == 0
    assert store.get_bridge_state() == {}


def test_migrate_bridge_state_dry_run_does_not_write(store, warroom):
    mod = _load_script()
    (warroom / ".notion_bridge_state.json").write_text('{"version":1}', "utf-8")
    n = mod._migrate_bridge_state(store, warroom, dry_run=True)
    assert n == 1
    assert store.get_bridge_state() == {}


# ---- _migrate_top_level_files --------------------------------------------


def test_migrate_top_level_files_copies_each(store, warroom):
    mod = _load_script()
    (warroom / "CURRENT_STATE.md").write_text("state v1", "utf-8")
    (warroom / "SHARED_MEMORY.md").write_text("memory v1", "utf-8")
    (warroom / "PROTOCOL.md").write_text("protocol v1", "utf-8")

    n = mod._migrate_top_level_files(store, warroom, dry_run=False)

    assert n == 3
    assert store.get_file("CURRENT_STATE.md") == "state v1"
    assert store.get_file("SHARED_MEMORY.md") == "memory v1"
    assert store.get_file("PROTOCOL.md") == "protocol v1"


def test_migrate_top_level_files_ignores_unknown_names(store, warroom):
    mod = _load_script()
    (warroom / "RANDOM_OTHER.md").write_text("should be ignored", "utf-8")
    n = mod._migrate_top_level_files(store, warroom, dry_run=False)
    assert n == 0


# ---- _migrate_kb ---------------------------------------------------------


def test_migrate_kb_copies_nested(store, warroom):
    mod = _load_script()
    kb = warroom / "KnowledgeBase"
    (kb / "intro.md").write_text("intro body", "utf-8")
    nested = kb / "guides"
    nested.mkdir()
    (nested / "onboarding.md").write_text("ob body", "utf-8")

    n = mod._migrate_kb(store, warroom, dry_run=False)

    assert n == 2
    assert store.get_kb_doc("intro.md") == "intro body"
    assert store.get_kb_doc("guides/onboarding.md") == "ob body"
    assert sorted(store.list_kb_docs()) == ["guides/onboarding.md", "intro.md"]


def test_migrate_kb_missing_dir_is_noop(store, warroom):
    mod = _load_script()
    # Wipe the KB dir to simulate missing.
    (warroom / "KnowledgeBase").rmdir()
    n = mod._migrate_kb(store, warroom, dry_run=False)
    assert n == 0
    assert store.list_kb_docs() == []


# ---- _migrate_skills -----------------------------------------------------


def test_migrate_skills_copies_files(store, warroom):
    mod = _load_script()
    (warroom / "Skill_Inbox" / "daily-digest.md").write_text("skill body", "utf-8")
    n = mod._migrate_skills(store, warroom, dry_run=False)
    assert n == 1
    assert store.get_skill("daily-digest.md") == "skill body"


# ---- _migrate_notion_inbox ----------------------------------------------


def test_migrate_notion_inbox_keys_by_filename(store, warroom):
    mod = _load_script()
    (warroom / "NotionInbox" / "wrb_aaaaaaaaaaaa.md").write_text(
        "# snapshot a", "utf-8"
    )
    (warroom / "NotionInbox" / "wrb_bbbbbbbbbbbb.md").write_text(
        "# snapshot b", "utf-8"
    )

    n = mod._migrate_notion_inbox(store, warroom, dry_run=False)

    assert n == 2
    assert store.get_notion_inbox("wrb_aaaaaaaaaaaa") == "# snapshot a"
    assert store.get_notion_inbox("wrb_bbbbbbbbbbbb") == "# snapshot b"


# ---- _migrate_handoffs --------------------------------------------------


def test_migrate_handoffs_upserts_each_block(store, warroom):
    mod = _load_script()
    (warroom / "HANDOFFS.md").write_text(
        "- Task: First task [wrb_aaaaaaaaaaaa]\n"
        "  Owner: Hermes\n"
        "  Files Touched: /wr/**\n"
        "  Status: COMPLETED\n"
        "  Result: ok\n"
        "  Next Action: None\n"
        "\n"
        "- Task: Second task [wrb_bbbbbbbbbbbb]\n"
        "  Owner: OpenClaw\n"
        "  Files Touched: /srv/**\n"
        "  Status: IN PROGRESS\n"
        "  Result:\n"
        "  Next Action: continue\n",
        "utf-8",
    )

    n = mod._migrate_handoffs(store, warroom, dry_run=False)

    assert n == 2
    a = store.get_handoff("wrb_aaaaaaaaaaaa")
    assert a["task"] == "First task"
    assert a["owner"] == "Hermes"
    assert a["status"] == "COMPLETED"
    b = store.get_handoff("wrb_bbbbbbbbbbbb")
    assert b["task"] == "Second task"
    assert b["owner"] == "OpenClaw"
    assert b["status"] == "IN PROGRESS"


def test_migrate_handoffs_missing_file_is_noop(store, warroom):
    mod = _load_script()
    n = mod._migrate_handoffs(store, warroom, dry_run=False)
    assert n == 0
    assert store.list_handoff_keys() == []


def test_migrate_handoffs_skips_malformed_blocks(store, warroom):
    mod = _load_script()
    (warroom / "HANDOFFS.md").write_text(
        "this is not a handoff\n"
        "- Task: no key here\n"
        "  Owner: Hermes\n"
        "  Status: PENDING\n",
        "utf-8",
    )
    n = mod._migrate_handoffs(store, warroom, dry_run=False)
    assert n == 0


# ---- End-to-end ---------------------------------------------------------


def test_main_end_to_end_writes_everything(store, warroom, monkeypatch, caplog):
    mod = _load_script()
    (warroom / ".notion_bridge_state.json").write_text(
        json.dumps({"version": 1, "pages": {}}), "utf-8"
    )
    (warroom / "CURRENT_STATE.md").write_text("state", "utf-8")
    (warroom / "KnowledgeBase" / "x.md").write_text("k", "utf-8")
    (warroom / "Skill_Inbox" / "s.md").write_text("s", "utf-8")
    (warroom / "NotionInbox" / "wrb_aaaaaaaaaaaa.md").write_text("snap", "utf-8")
    (warroom / "HANDOFFS.md").write_text(
        "- Task: t [wrb_aaaaaaaaaaaa]\n"
        "  Owner: Hermes\n"
        "  Files Touched: x\n"
        "  Status: PENDING\n"
        "  Result:\n"
        "  Next Action: go\n",
        "utf-8",
    )

    # Run each helper manually with the real store; main() would need a
    # connectable Redis. Helpers exercise the same code paths.
    assert mod._migrate_bridge_state(store, warroom, dry_run=False) == 1
    assert mod._migrate_top_level_files(store, warroom, dry_run=False) == 1
    assert mod._migrate_kb(store, warroom, dry_run=False) == 1
    assert mod._migrate_skills(store, warroom, dry_run=False) == 1
    assert mod._migrate_notion_inbox(store, warroom, dry_run=False) == 1
    assert mod._migrate_handoffs(store, warroom, dry_run=False) == 1

    # All scopes reachable in Redis.
    assert store.get_bridge_state() == {"version": 1, "pages": {}}
    assert store.get_file("CURRENT_STATE.md") == "state"
    assert "x.md" in store.list_kb_docs()
    assert "s.md" in store.list_skills()
    assert store.get_notion_inbox("wrb_aaaaaaaaaaaa") == "snap"
    assert store.get_handoff("wrb_aaaaaaaaaaaa") is not None
