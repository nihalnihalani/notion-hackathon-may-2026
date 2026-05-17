"""Tests for src/redis_store.py — uses fakeredis, no live Redis needed."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import fakeredis
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.redis_store import (  # noqa: E402
    HANDOFFS_ALL,
    HANDOFFS_ORDER,
    KB_INDEX,
    LOCK_KEY,
    SKILL_INDEX,
    RedisStore,
    RedisStoreError,
)


@pytest.fixture
def store() -> RedisStore:
    return RedisStore(client=fakeredis.FakeRedis(decode_responses=True))


# ---- Construction --------------------------------------------------------


def test_constructor_requires_url_or_client(monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    with pytest.raises(RedisStoreError):
        RedisStore()


def test_constructor_accepts_client_kwarg():
    store = RedisStore(client=fakeredis.FakeRedis(decode_responses=True))
    store.set_file("CURRENT_STATE.md", "hello")
    assert store.get_file("CURRENT_STATE.md") == "hello"


# ---- Files ---------------------------------------------------------------


def test_file_round_trip(store):
    store.set_file("SHARED_MEMORY.md", "note 1\nnote 2\n")
    assert store.get_file("SHARED_MEMORY.md") == "note 1\nnote 2\n"


def test_file_missing_returns_none(store):
    assert store.get_file("not_set.md") is None


def test_file_delete(store):
    store.set_file("x.md", "data")
    store.delete_file("x.md")
    assert store.get_file("x.md") is None


def test_file_overwrite(store):
    store.set_file("a.md", "v1")
    store.set_file("a.md", "v2")
    assert store.get_file("a.md") == "v2"


# ---- Handoffs ------------------------------------------------------------


def test_upsert_handoff_creates_full_record(store):
    store.upsert_handoff(
        "wrb_aaaaaaaaaaaa",
        task="Inspect health",
        owner="Hermes",
        files_touched="/wr/**",
        status="PENDING",
        result="",
        next_action="Review inbox",
        context="full context here",
    )
    h = store.get_handoff("wrb_aaaaaaaaaaaa")
    assert h["task"] == "Inspect health"
    assert h["owner"] == "Hermes"
    assert h["status"] == "PENDING"
    assert h["last_updated_at"]  # auto-set


def test_upsert_handoff_indexes_by_status(store):
    store.upsert_handoff("wrb_aaaaaaaaaaaa", owner="Hermes", status="PENDING")
    store.upsert_handoff("wrb_bbbbbbbbbbbb", owner="OpenClaw", status="COMPLETED")
    assert store.list_handoff_keys_by_status("PENDING") == {"wrb_aaaaaaaaaaaa"}
    assert store.list_handoff_keys_by_status("COMPLETED") == {"wrb_bbbbbbbbbbbb"}


def test_upsert_handoff_moves_between_status_sets(store):
    store.upsert_handoff("wrb_aaaaaaaaaaaa", status="PENDING")
    assert store.list_handoff_keys_by_status("PENDING") == {"wrb_aaaaaaaaaaaa"}
    store.upsert_handoff("wrb_aaaaaaaaaaaa", status="COMPLETED")
    assert store.list_handoff_keys_by_status("PENDING") == set()
    assert store.list_handoff_keys_by_status("COMPLETED") == {"wrb_aaaaaaaaaaaa"}


def test_upsert_handoff_partial_update_preserves_fields(store):
    store.upsert_handoff(
        "wrb_aaaaaaaaaaaa",
        task="Inspect health",
        owner="Hermes",
        files_touched="/wr/**",
        status="PENDING",
    )
    store.upsert_handoff("wrb_aaaaaaaaaaaa", status="COMPLETED", result="done")
    h = store.get_handoff("wrb_aaaaaaaaaaaa")
    assert h["task"] == "Inspect health"
    assert h["status"] == "COMPLETED"
    assert h["result"] == "done"


def test_get_handoff_missing_returns_none(store):
    assert store.get_handoff("wrb_nothere00000") is None


def test_delete_handoff_clears_indexes(store):
    store.upsert_handoff("wrb_aaaaaaaaaaaa", status="PENDING")
    store.delete_handoff("wrb_aaaaaaaaaaaa")
    assert store.get_handoff("wrb_aaaaaaaaaaaa") is None
    assert "wrb_aaaaaaaaaaaa" not in store.list_handoff_keys()
    assert store.list_handoff_keys_by_status("PENDING") == set()


def test_list_handoffs_in_order(store):
    store.upsert_handoff("wrb_aaaaaaaaaaaa", task="first", owner="Hermes", status="PENDING")
    time.sleep(0.005)
    store.upsert_handoff("wrb_bbbbbbbbbbbb", task="second", owner="OpenClaw", status="PENDING")
    keys = store.list_handoff_keys()
    assert keys == ["wrb_aaaaaaaaaaaa", "wrb_bbbbbbbbbbbb"]


def test_render_handoffs_md_matches_protocol(store):
    store.upsert_handoff(
        "wrb_aaaaaaaaaaaa",
        task="Inspect health",
        owner="Hermes",
        files_touched="/wr/**",
        status="PENDING",
        result="",
        next_action="Review inbox",
    )
    md = store.render_handoffs_md()
    assert "- Task: Inspect health [wrb_aaaaaaaaaaaa]" in md
    assert "  Owner: Hermes" in md
    assert "  Status: PENDING" in md
    assert "  Result:" in md
    assert "  Next Action: Review inbox" in md


def test_render_handoffs_md_round_trips_through_parse_handoffs(store):
    """The Redis-materialised text must be parseable by the existing parser."""
    from src.warroom_format import parse_handoffs

    store.upsert_handoff(
        "wrb_aaaaaaaaaaaa",
        task="t",
        owner="Hermes",
        files_touched="/wr/**",
        status="COMPLETED",
        result="ok",
        next_action="None",
    )
    entries = list(parse_handoffs(store.render_handoffs_md()))
    assert len(entries) == 1
    key, fields = entries[0]
    assert key == "wrb_aaaaaaaaaaaa"
    assert fields["Status"] == "COMPLETED"
    assert fields["Result"] == "ok"


# ---- Notion inbox snapshots ---------------------------------------------


def test_notion_inbox_round_trip(store):
    store.set_notion_inbox("wrb_aaaaaaaaaaaa", "# Snapshot\nbody")
    assert store.get_notion_inbox("wrb_aaaaaaaaaaaa") == "# Snapshot\nbody"


# ---- Knowledge base ----------------------------------------------------


def test_kb_round_trip(store):
    store.set_kb_doc("intro.md", "intro content")
    store.set_kb_doc("guides/onboarding.md", "ob content")
    assert store.get_kb_doc("intro.md") == "intro content"
    assert store.list_kb_docs() == ["guides/onboarding.md", "intro.md"]


def test_kb_delete(store):
    store.set_kb_doc("x.md", "x")
    store.delete_kb_doc("x.md")
    assert store.get_kb_doc("x.md") is None
    assert "x.md" not in store.list_kb_docs()


# ---- Skill inbox ------------------------------------------------------


def test_skill_round_trip(store):
    store.set_skill("daily-digest", "the skill text")
    assert store.get_skill("daily-digest") == "the skill text"
    assert "daily-digest" in store.list_skills()


# ---- Bridge state ----------------------------------------------------


def test_bridge_state_round_trip(store):
    state = {
        "version": 1,
        "command_center_data_source_id": "ds_xyz",
        "dashboard_block_id": "blk_1",
        "pages": {"page_a": {"handoff_key": "wrb_aaaaaaaaaaaa"}},
    }
    store.set_bridge_state(state)
    assert store.get_bridge_state() == state


def test_bridge_state_missing_returns_empty_dict(store):
    assert store.get_bridge_state() == {}


def test_bridge_state_rejects_non_dict(store):
    with pytest.raises(TypeError):
        store.set_bridge_state([1, 2, 3])  # type: ignore[arg-type]


# ---- Lock ------------------------------------------------------------


def test_locked_acquires_and_releases(store):
    with store.locked():
        # While held, the key exists.
        assert store.r.get(LOCK_KEY) is not None
    # After release, the key is gone.
    assert store.r.get(LOCK_KEY) is None


def test_locked_lock_is_held_within_block(store):
    with store.locked():
        # A second acquisition attempt with a short timeout must fail.
        with pytest.raises(RedisStoreError):
            with store.locked(timeout_seconds=0.2):
                pass


def test_locked_releases_on_exception(store):
    with pytest.raises(ValueError):
        with store.locked():
            raise ValueError("boom")
    # Lock cleared so we can re-acquire.
    with store.locked():
        pass


# ---- Wipe ------------------------------------------------------------


def test_wipe_clears_all_wr_keys(store):
    store.set_file("a.md", "v")
    store.upsert_handoff("wrb_aaaaaaaaaaaa", status="PENDING")
    store.set_kb_doc("x.md", "kb")
    store.set_skill("s", "skill")
    store.set_bridge_state({"version": 1})
    store.wipe()
    assert store.get_file("a.md") is None
    assert store.list_handoff_keys() == []
    assert store.list_kb_docs() == []
    assert store.list_skills() == []
    assert store.get_bridge_state() == {}
