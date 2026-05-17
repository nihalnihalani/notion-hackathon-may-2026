"""Unit tests for src/state_store.py.

These tests exercise the JSON persistence, atomicity, idempotency, and
helper semantics required by plan.md Task 5. All filesystem I/O is confined
to pytest's tmp_path; no network or shared state is involved.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src import state_store  # noqa: E402
from src.state_store import (  # noqa: E402
    HANDOFF_KEY_HEX_LENGTH,
    HANDOFF_KEY_PREFIX,
    LOCK_FILENAME,
    SCHEMA_VERSION,
    STATE_FILENAME,
    StateStore,
    StateStoreError,
    UnknownHandoffKeyError,
    empty_state,
    handoff_key_for_page,
)


# ---- handoff_key_for_page --------------------------------------------------


def test_handoff_key_is_deterministic_and_well_formed():
    key = handoff_key_for_page("page-1234")
    assert key.startswith(HANDOFF_KEY_PREFIX)
    hex_part = key[len(HANDOFF_KEY_PREFIX):]
    assert len(hex_part) == HANDOFF_KEY_HEX_LENGTH
    assert all(c in "0123456789abcdef" for c in hex_part)
    # Stable across calls.
    assert handoff_key_for_page("page-1234") == key


def test_handoff_key_distinct_for_distinct_pages():
    a = handoff_key_for_page("notion-page-A")
    b = handoff_key_for_page("notion-page-B")
    assert a != b


def test_handoff_key_classmethod_matches_module_function():
    assert (
        StateStore.handoff_key_for_page("page-xyz")
        == handoff_key_for_page("page-xyz")
    )


def test_handoff_key_rejects_empty_page_id():
    with pytest.raises(ValueError):
        handoff_key_for_page("")


# ---- Paths / construction --------------------------------------------------


def test_paths_are_anchored_in_warroom_directory(tmp_path):
    store = StateStore(tmp_path)
    assert store.state_path == tmp_path / STATE_FILENAME
    assert store.lock_path == tmp_path / LOCK_FILENAME
    assert STATE_FILENAME == ".notion_bridge_state.json"
    assert LOCK_FILENAME == ".notion_bridge.lock"


def test_store_accepts_str_path(tmp_path):
    store = StateStore(str(tmp_path))
    assert store.warroom_path == Path(str(tmp_path))


def test_constructor_rejects_none():
    with pytest.raises(ValueError):
        StateStore(None)  # type: ignore[arg-type]


# ---- Load / save round trip ------------------------------------------------


def test_load_returns_empty_state_when_file_missing(tmp_path):
    store = StateStore(tmp_path)
    state = store.load()
    assert state == empty_state()
    assert state["version"] == SCHEMA_VERSION
    assert state["pages"] == {}
    assert state["command_center_data_source_id"] is None
    assert state["dashboard_block_id"] is None


def test_save_then_load_round_trips(tmp_path):
    store = StateStore(tmp_path)
    state = empty_state()
    state["command_center_data_source_id"] = "ds_1"
    state["dashboard_block_id"] = "blk_1"
    state["pages"]["page_a"] = {
        "handoff_key": "wrb_aaaa11112222",
        "last_local_status": "PENDING",
        "last_notion_status": "Dispatched",
        "last_result_hash": None,
    }
    store.save(state)

    reloaded = store.load()
    assert reloaded == state


def test_save_persists_to_expected_state_filename(tmp_path):
    store = StateStore(tmp_path)
    store.save(empty_state())
    assert (tmp_path / STATE_FILENAME).is_file()


def test_save_uses_os_replace_with_temp_file(tmp_path, monkeypatch):
    store = StateStore(tmp_path)
    captured: dict[str, tuple[str, str]] = {}
    real_replace = os.replace

    def spy_replace(src, dst):
        captured["call"] = (str(src), str(dst))
        return real_replace(src, dst)

    monkeypatch.setattr(state_store.os, "replace", spy_replace)
    store.save(empty_state())

    assert "call" in captured, "save() did not call os.replace"
    src_path, dst_path = captured["call"]
    assert dst_path == str(store.state_path)
    assert src_path != dst_path
    src = Path(src_path)
    # Temp file lives next to the final file (same dir == atomic rename safe).
    assert src.parent == store.state_path.parent
    assert src.name.startswith(".notion_bridge_state.")
    assert src.name.endswith(".tmp")


def test_load_raises_on_corrupt_json(tmp_path):
    store = StateStore(tmp_path)
    store.state_path.write_text("{not valid json", encoding="utf-8")
    with pytest.raises(StateStoreError):
        store.load()


def test_load_raises_on_non_object_root(tmp_path):
    store = StateStore(tmp_path)
    store.state_path.write_text("[1, 2, 3]", encoding="utf-8")
    with pytest.raises(StateStoreError):
        store.load()


def test_load_fills_missing_structural_keys(tmp_path):
    store = StateStore(tmp_path)
    store.state_path.write_text(json.dumps({"version": 1}), encoding="utf-8")
    state = store.load()
    assert state["pages"] == {}
    assert state["command_center_data_source_id"] is None
    assert state["dashboard_block_id"] is None


# ---- Atomicity -------------------------------------------------------------


def test_save_is_atomic_when_os_replace_fails(tmp_path, monkeypatch):
    """If os.replace fails, the existing state file must be untouched."""
    store = StateStore(tmp_path)
    initial = empty_state()
    initial["pages"]["page_a"] = {"handoff_key": "wrb_old"}
    store.save(initial)
    original_bytes = store.state_path.read_bytes()

    def boom(src, dst):
        raise OSError("simulated crash during rename")

    monkeypatch.setattr(state_store.os, "replace", boom)

    overwrite = empty_state()
    overwrite["pages"]["page_a"] = {"handoff_key": "wrb_new"}
    with pytest.raises(OSError):
        store.save(overwrite)

    # Original state file bytes are intact.
    assert store.state_path.read_bytes() == original_bytes

    # No leftover temp turds in the directory.
    leftovers = [
        p
        for p in tmp_path.iterdir()
        if p.name.startswith(".notion_bridge_state.") and p.name.endswith(".tmp")
    ]
    assert leftovers == []


def test_save_is_atomic_when_json_serialization_fails(tmp_path, monkeypatch):
    """If serialization blows up mid-write, original state survives."""
    store = StateStore(tmp_path)
    initial = empty_state()
    initial["pages"]["page_a"] = {"handoff_key": "wrb_old"}
    store.save(initial)
    original_bytes = store.state_path.read_bytes()

    real_dump = state_store.json.dump

    def fail_dump(obj, fp, **kwargs):
        fp.write('{"version": 1, "pa')  # partial
        raise RuntimeError("simulated mid-write failure")

    monkeypatch.setattr(state_store.json, "dump", fail_dump)

    with pytest.raises(RuntimeError):
        store.save(empty_state())

    monkeypatch.setattr(state_store.json, "dump", real_dump)
    assert store.state_path.read_bytes() == original_bytes
    leftovers = [
        p
        for p in tmp_path.iterdir()
        if p.name.startswith(".notion_bridge_state.") and p.name.endswith(".tmp")
    ]
    assert leftovers == []


def test_save_creates_warroom_directory_if_missing(tmp_path):
    nested = tmp_path / "doesnotexist" / "warroom"
    store = StateStore(nested)
    store.save(empty_state())
    assert nested.is_dir()
    assert (nested / STATE_FILENAME).is_file()


def test_save_rejects_non_mapping(tmp_path):
    store = StateStore(tmp_path)
    with pytest.raises(TypeError):
        store.save([1, 2, 3])  # type: ignore[arg-type]


# ---- mark_dispatched -------------------------------------------------------


def test_mark_dispatched_writes_full_page_entry(tmp_path):
    store = StateStore(tmp_path)
    key = handoff_key_for_page("page_a")
    entry = store.mark_dispatched(
        key,
        "page_a",
        context_path="/home/alhinai/WarRoom/NotionInbox/wrb_x.md",
        last_synced_at="2026-05-17T12:00:00Z",
        last_sync_hash="hashAAA",
    )
    assert entry["handoff_key"] == key
    assert entry["context_path"] == "/home/alhinai/WarRoom/NotionInbox/wrb_x.md"
    assert entry["last_notion_status"] == "Dispatched"
    assert entry["last_local_status"] == "PENDING"
    assert entry["last_synced_at"] == "2026-05-17T12:00:00Z"
    assert entry["last_sync_hash"] == "hashAAA"
    assert entry["last_result_hash"] is None
    assert entry["last_next_action_hash"] is None
    assert entry["last_result_block_id"] is None

    state = store.load()
    assert "page_a" in state["pages"]
    assert state["pages"]["page_a"] == entry


def test_mark_dispatched_is_idempotent_for_same_page(tmp_path):
    """Duplicate page ID does not create duplicate handoff."""
    store = StateStore(tmp_path)
    key = handoff_key_for_page("page_a")

    store.mark_dispatched(key, "page_a", context_path="/wr/inbox/a.md")
    store.mark_dispatched(key, "page_a", context_path="/wr/inbox/a.md")
    store.mark_dispatched(key, "page_a", context_path="/wr/inbox/a.md")

    state = store.load()
    assert list(state["pages"].keys()) == ["page_a"]
    # Only one entry, still a single handoff key.
    assert state["pages"]["page_a"]["handoff_key"] == key


def test_mark_dispatched_preserves_existing_fields_when_not_overridden(tmp_path):
    store = StateStore(tmp_path)
    key = handoff_key_for_page("page_a")
    store.mark_dispatched(
        key,
        "page_a",
        context_path="/wr/inbox/a.md",
        last_synced_at="2026-05-17T10:00:00Z",
        last_sync_hash="seed-hash",
    )
    # Manually annotate state with a result hash (as result_sync would).
    state = store.load()
    state["pages"]["page_a"]["last_result_hash"] = "result-hash-1"
    state["pages"]["page_a"]["last_result_block_id"] = "blk_xyz"
    store.save(state)

    # Re-dispatch (e.g., bridge restart): the prior result tracking must
    # survive so we don't accidentally resync stale state.
    store.mark_dispatched(key, "page_a")
    reloaded = store.load()["pages"]["page_a"]
    assert reloaded["last_result_hash"] == "result-hash-1"
    assert reloaded["last_result_block_id"] == "blk_xyz"
    # And the still-known scalars persist.
    assert reloaded["context_path"] == "/wr/inbox/a.md"
    assert reloaded["last_sync_hash"] == "seed-hash"


def test_mark_dispatched_does_not_collide_across_pages(tmp_path):
    store = StateStore(tmp_path)
    key_a = handoff_key_for_page("page_a")
    key_b = handoff_key_for_page("page_b")
    store.mark_dispatched(key_a, "page_a", context_path="/wr/inbox/a.md")
    store.mark_dispatched(key_b, "page_b", context_path="/wr/inbox/b.md")
    state = store.load()
    assert set(state["pages"].keys()) == {"page_a", "page_b"}
    assert state["pages"]["page_a"]["handoff_key"] == key_a
    assert state["pages"]["page_b"]["handoff_key"] == key_b


def test_mark_dispatched_requires_key_and_page_id(tmp_path):
    store = StateStore(tmp_path)
    with pytest.raises(ValueError):
        store.mark_dispatched("", "page_a")
    with pytest.raises(ValueError):
        store.mark_dispatched("wrb_xxx", "")


# ---- get_page_by_key -------------------------------------------------------


def test_get_page_by_key_returns_entry_with_page_id(tmp_path):
    store = StateStore(tmp_path)
    key = handoff_key_for_page("page_a")
    store.mark_dispatched(key, "page_a", context_path="/wr/inbox/a.md")
    found = store.get_page_by_key(key)
    assert found is not None
    assert found["page_id"] == "page_a"
    assert found["handoff_key"] == key
    assert found["context_path"] == "/wr/inbox/a.md"


def test_get_page_by_key_returns_none_for_unknown(tmp_path):
    store = StateStore(tmp_path)
    assert store.get_page_by_key("wrb_doesnotexist") is None


def test_get_page_by_key_empty_returns_none(tmp_path):
    store = StateStore(tmp_path)
    assert store.get_page_by_key("") is None


def test_get_page_by_key_returns_copy_not_live_reference(tmp_path):
    store = StateStore(tmp_path)
    key = handoff_key_for_page("page_a")
    store.mark_dispatched(key, "page_a")
    found = store.get_page_by_key(key)
    assert found is not None
    found["handoff_key"] = "wrb_mutated"
    # Mutating the returned dict must not corrupt persisted state.
    persisted = store.load()["pages"]["page_a"]
    assert persisted["handoff_key"] == key


# ---- mark_result_synced ----------------------------------------------------


def test_mark_result_synced_records_hash(tmp_path):
    store = StateStore(tmp_path)
    key = handoff_key_for_page("page_a")
    store.mark_dispatched(key, "page_a", context_path="/wr/inbox/a.md")
    entry = store.mark_result_synced(
        key,
        "result-hash-1",
        next_action_hash="next-action-hash-1",
        last_local_status="COMPLETED",
        last_notion_status="Completed",
        last_synced_at="2026-05-17T13:00:00Z",
        last_result_block_id="blk_result_1",
    )
    assert entry["last_result_hash"] == "result-hash-1"
    assert entry["last_next_action_hash"] == "next-action-hash-1"
    assert entry["last_local_status"] == "COMPLETED"
    assert entry["last_notion_status"] == "Completed"
    assert entry["last_synced_at"] == "2026-05-17T13:00:00Z"
    assert entry["last_result_block_id"] == "blk_result_1"

    persisted = store.load()["pages"]["page_a"]
    assert persisted["last_result_hash"] == "result-hash-1"
    assert persisted["last_result_block_id"] == "blk_result_1"


def test_hash_changes_trigger_resync(tmp_path):
    """A second mark_result_synced with a new hash updates state in place."""
    store = StateStore(tmp_path)
    key = handoff_key_for_page("page_a")
    store.mark_dispatched(key, "page_a")
    assert store.load()["pages"]["page_a"]["last_result_hash"] is None

    store.mark_result_synced(key, "hash-v1")
    assert store.load()["pages"]["page_a"]["last_result_hash"] == "hash-v1"

    # Same hash again -> still stored as v1, no exception (idempotent).
    store.mark_result_synced(key, "hash-v1")
    assert store.load()["pages"]["page_a"]["last_result_hash"] == "hash-v1"

    # Hash changes -> stored value is updated.
    store.mark_result_synced(key, "hash-v2")
    assert store.load()["pages"]["page_a"]["last_result_hash"] == "hash-v2"


def test_mark_result_synced_raises_for_unknown_key(tmp_path):
    store = StateStore(tmp_path)
    with pytest.raises(UnknownHandoffKeyError):
        store.mark_result_synced("wrb_doesnotexist", "hash")


def test_mark_result_synced_requires_key_and_hash(tmp_path):
    store = StateStore(tmp_path)
    key = handoff_key_for_page("page_a")
    store.mark_dispatched(key, "page_a")
    with pytest.raises(ValueError):
        store.mark_result_synced("", "hash")
    with pytest.raises(ValueError):
        store.mark_result_synced(key, None)  # type: ignore[arg-type]


def test_mark_result_synced_does_not_overwrite_unrelated_fields(tmp_path):
    store = StateStore(tmp_path)
    key = handoff_key_for_page("page_a")
    store.mark_dispatched(
        key,
        "page_a",
        context_path="/wr/inbox/a.md",
        last_synced_at="2026-05-17T10:00:00Z",
        last_sync_hash="dispatch-hash",
    )
    store.mark_result_synced(key, "result-hash-1")
    entry = store.load()["pages"]["page_a"]
    # context_path / handoff_key / last_sync_hash from dispatch must remain.
    assert entry["context_path"] == "/wr/inbox/a.md"
    assert entry["handoff_key"] == key
    assert entry["last_sync_hash"] == "dispatch-hash"


# ---- Convenience setters ---------------------------------------------------


def test_set_command_center_data_source_id_persists(tmp_path):
    store = StateStore(tmp_path)
    store.set_command_center_data_source_id("ds_first")
    assert store.load()["command_center_data_source_id"] == "ds_first"
    store.set_command_center_data_source_id(None)
    assert store.load()["command_center_data_source_id"] is None


def test_set_dashboard_block_id_persists(tmp_path):
    store = StateStore(tmp_path)
    store.set_dashboard_block_id("blk_dashboard")
    assert store.load()["dashboard_block_id"] == "blk_dashboard"
    store.set_dashboard_block_id(None)
    assert store.load()["dashboard_block_id"] is None


# ---- Locking ---------------------------------------------------------------


def test_locked_context_creates_and_releases_lock(tmp_path):
    store = StateStore(tmp_path)
    assert not store._lock.is_locked
    with store.locked() as inner:
        assert inner is store
        assert store._lock.is_locked
    assert not store._lock.is_locked


def test_lock_is_reentrant_within_same_thread(tmp_path):
    """Nested helper calls inside store.locked() must not deadlock."""
    store = StateStore(tmp_path)
    key = handoff_key_for_page("page_a")
    with store.locked():
        # mark_dispatched re-enters store.locked() internally.
        store.mark_dispatched(key, "page_a")
        store.mark_result_synced(key, "hash-v1")
    persisted = store.load()["pages"]["page_a"]
    assert persisted["handoff_key"] == key
    assert persisted["last_result_hash"] == "hash-v1"


def test_lock_file_lives_in_warroom_directory(tmp_path):
    store = StateStore(tmp_path)
    with store.locked():
        # FileLock materializes the lock file on acquire.
        assert store.lock_path.parent == tmp_path
        assert store.lock_path.name == LOCK_FILENAME


# ---- Schema invariants -----------------------------------------------------


def test_persisted_json_is_human_readable(tmp_path):
    store = StateStore(tmp_path)
    key = handoff_key_for_page("page_a")
    store.mark_dispatched(key, "page_a", context_path="/wr/inbox/a.md")
    raw = store.state_path.read_text(encoding="utf-8")
    # indented + sorted means a stable, diff-friendly file.
    assert "\n" in raw
    assert '"pages"' in raw
    parsed = json.loads(raw)
    assert parsed["version"] == SCHEMA_VERSION
    assert "page_a" in parsed["pages"]


def test_empty_state_shape_matches_plan():
    state = empty_state()
    assert set(state.keys()) == {
        "version",
        "command_center_data_source_id",
        "dashboard_block_id",
        "mission_control",
        "pages",
        "kb_pages",
        "skill_pages",
    }
    assert state["version"] == 1
    assert state["kb_pages"] == {}
    assert state["skill_pages"] == {}

# ---- Mission Control block/hash aliases ------------------------------------


def test_mc_block_and_hash(tmp_path):
    store = StateStore(tmp_path)
    # Default is None
    assert store.get_mc_block("config_file") is None
    assert store.get_mc_hash("config_file") is None

    # Set and get block
    store.set_mc_block("config_file", "block_123")
    assert store.get_mc_block("config_file") == "block_123"
    assert store.get_mc_hash("config_file") is None

    # Set and get hash
    store.set_mc_hash("config_file", "hash_abc")
    assert store.get_mc_block("config_file") == "block_123"
    assert store.get_mc_hash("config_file") == "hash_abc"

    # Set another file
    store.set_mc_block("other_file", "block_456")
    assert store.get_mc_block("other_file") == "block_456"
    assert store.get_mc_block("config_file") == "block_123"

    # Overwrite
    store.set_mc_block("config_file", "block_new")
    assert store.get_mc_block("config_file") == "block_new"
    
    # Check persistence
    store2 = StateStore(tmp_path)
    assert store2.get_mc_block("config_file") == "block_new"
    assert store2.get_mc_hash("config_file") == "hash_abc"
    assert store2.get_mc_block("other_file") == "block_456"


# ---- KB / Skill Inbox page helpers ----------------------------------------


def test_kb_page_helpers_default_to_none(tmp_path):
    store = StateStore(tmp_path)
    assert store.get_kb_page("missing-key") is None


def test_kb_page_helpers_round_trip(tmp_path):
    store = StateStore(tmp_path)
    store.set_kb_page("section-1", "page_abc", "hash_v1")

    entry = store.get_kb_page("section-1")
    assert entry == {"page_id": "page_abc", "hash": "hash_v1"}

    # Updating overwrites in place.
    store.set_kb_page("section-1", "page_abc", "hash_v2")
    assert store.get_kb_page("section-1") == {
        "page_id": "page_abc",
        "hash": "hash_v2",
    }

    # Other keys untouched.
    store.set_kb_page("section-2", "page_xyz", "hash_a")
    assert store.get_kb_page("section-2") == {
        "page_id": "page_xyz",
        "hash": "hash_a",
    }
    assert store.get_kb_page("section-1") == {
        "page_id": "page_abc",
        "hash": "hash_v2",
    }


def test_kb_page_persists_across_store_instances(tmp_path):
    store = StateStore(tmp_path)
    store.set_kb_page("section-1", "page_abc", "hash_v1")
    fresh = StateStore(tmp_path)
    assert fresh.get_kb_page("section-1") == {
        "page_id": "page_abc",
        "hash": "hash_v1",
    }


def test_kb_page_clear_with_none_page_id(tmp_path):
    store = StateStore(tmp_path)
    store.set_kb_page("section-1", "page_abc", "hash_v1")
    store.set_kb_page("section-1", None, None)
    assert store.get_kb_page("section-1") is None


def test_kb_page_requires_section_key(tmp_path):
    store = StateStore(tmp_path)
    with pytest.raises(ValueError):
        store.set_kb_page("", "page_abc", "hash_v1")
    assert store.get_kb_page("") is None


def test_skill_page_helpers_round_trip(tmp_path):
    store = StateStore(tmp_path)
    assert store.get_skill_page("skill-key") is None
    store.set_skill_page("skill-key", "page_xyz", "hash_v1")
    assert store.get_skill_page("skill-key") == {
        "page_id": "page_xyz",
        "hash": "hash_v1",
    }


def test_kb_and_skill_buckets_are_isolated(tmp_path):
    store = StateStore(tmp_path)
    store.set_kb_page("shared-key", "page_kb", "hash_kb")
    store.set_skill_page("shared-key", "page_skill", "hash_skill")
    assert store.get_kb_page("shared-key") == {
        "page_id": "page_kb",
        "hash": "hash_kb",
    }
    assert store.get_skill_page("shared-key") == {
        "page_id": "page_skill",
        "hash": "hash_skill",
    }

