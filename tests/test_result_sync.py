"""Unit tests for src/result_sync.py (plan.md Task 7) — Redis-backed.

Covers:
- COMPLETED handoff syncs status + result + next action to Notion.
- BLOCKED handoff syncs blocker info.
- A second sync with the same content is a no-op (hash idempotency).
- Result text changing triggers a resync.
- Missing bridge key in HANDOFFS.md is ignored silently.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import fakeredis
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.redis_store import RedisStore  # noqa: E402
from src.result_sync import sync_results  # noqa: E402
from src.state_store import handoff_key_for_page  # noqa: E402
from src.warroom_format import parse_handoffs  # noqa: E402


@pytest.fixture
def store() -> RedisStore:
    return RedisStore(client=fakeredis.FakeRedis(decode_responses=True))


def _make_client():
    client = MagicMock()
    client.update_page.return_value = {"object": "page"}
    client.append_block_children.return_value = {
        "results": [{"id": "blk_result_1", "type": "code"}]
    }
    client.update_block.return_value = {"object": "block", "id": "blk_result_1"}
    return client


def _seed_dispatch(store: RedisStore, page_id: str) -> str:
    """Record a page→handoff association in the bridge state, mirroring
    the bridge-state shape produced by `sync_dispatch`."""
    key = handoff_key_for_page(page_id)
    state = store.get_bridge_state() or {}
    pages = state.setdefault("pages", {})
    pages[page_id] = {
        "handoff_key": key,
        "context_path": f"/tmp/inbox/{key}.md",
        "last_notion_status": "Dispatched",
        "last_local_status": "PENDING",
        "last_synced_at": "2026-05-17T10:00:00Z",
        "last_sync_hash": "dispatch-hash",
        "last_result_hash": None,
        "last_next_action_hash": None,
        "last_result_block_id": None,
    }
    store.set_bridge_state(state)
    return key


def _upsert_handoff_from_fields(
    store: RedisStore,
    key: str,
    *,
    task: str = "t",
    owner: str = "Hermes",
    files_touched: str = "**",
    status: str = "COMPLETED",
    result: str = "Done",
    next_action: str = "None",
) -> None:
    store.upsert_handoff(
        key,
        task=task,
        owner=owner,
        files_touched=files_touched,
        status=status,
        result=result,
        next_action=next_action,
    )


# ---- parse_handoffs --------------------------------------------------------


def test_parse_handoffs_extracts_key_and_fields():
    text = (
        "- Task: Do work [wrb_abc123456789]\n"
        "  Owner: Hermes\n"
        "  Files Touched: **\n"
        "  Status: COMPLETED\n"
        "  Result: Done\n"
        "  Next Action: None\n"
    )
    entries = list(parse_handoffs(text))
    assert len(entries) == 1
    key, fields = entries[0]
    assert key == "wrb_abc123456789"
    assert fields["Status"] == "COMPLETED"
    assert fields["Result"] == "Done"


# ---- sync_results end-to-end ----------------------------------------------


def test_completed_handoff_syncs_status_result_next_action(store):
    key = _seed_dispatch(store, "page_aaa")
    _upsert_handoff_from_fields(
        store,
        key,
        status="COMPLETED",
        result="All clear",
        next_action="None",
    )
    client = _make_client()

    pushed = sync_results(client, store=store)

    assert pushed == 1
    args, _ = client.update_page.call_args
    assert args[0] == "page_aaa"
    props = args[1]
    assert props["Status"]["status"]["name"] == "Completed"
    assert (
        props["Result Summary"]["rich_text"][0]["text"]["content"] == "All clear"
    )
    assert (
        props["Next Action"]["rich_text"][0]["text"]["content"] == "None"
    )
    # A result block was created exactly once.
    client.append_block_children.assert_called_once()
    persisted = store.get_bridge_state()["pages"]["page_aaa"]
    assert persisted["last_notion_status"] == "Completed"
    assert persisted["last_result_block_id"] == "blk_result_1"


def test_blocked_handoff_syncs_blocker(store):
    key = _seed_dispatch(store, "page_bbb")
    _upsert_handoff_from_fields(
        store,
        key,
        owner="OpenClaw",
        status="BLOCKED",
        result="need credentials",
        next_action="Provide PROD_TOKEN env var",
    )
    client = _make_client()

    pushed = sync_results(client, store=store)
    assert pushed == 1
    props = client.update_page.call_args.args[1]
    assert props["Status"]["status"]["name"] == "Blocked"
    assert (
        props["Result Summary"]["rich_text"][0]["text"]["content"]
        == "need credentials"
    )


def test_unchanged_handoff_does_not_call_notion_again(store):
    key = _seed_dispatch(store, "page_aaa")
    _upsert_handoff_from_fields(store, key)
    client = _make_client()
    sync_results(client, store=store)
    client.reset_mock()

    pushed = sync_results(client, store=store)

    assert pushed == 0
    client.update_page.assert_not_called()
    client.append_block_children.assert_not_called()
    client.update_block.assert_not_called()


def test_changed_result_triggers_resync_and_block_update(store):
    key = _seed_dispatch(store, "page_aaa")
    _upsert_handoff_from_fields(store, key, result="Done", next_action="None")
    client = _make_client()
    sync_results(client, store=store)
    client.reset_mock()

    # Bump the result text and resync.
    _upsert_handoff_from_fields(
        store, key, result="Done with a follow-up note", next_action="None"
    )

    pushed = sync_results(client, store=store)
    assert pushed == 1
    client.update_page.assert_called_once()
    # Existing block updated in place; no new block appended.
    client.update_block.assert_called_once()
    client.append_block_children.assert_not_called()


def test_missing_bridge_key_is_ignored(store):
    # A handoff that was never upserted with a wrb_ key (orphan render) — the
    # store has no entries at all. sync_results should noop and not call Notion.
    client = _make_client()
    pushed = sync_results(client, store=store)
    assert pushed == 0
    client.update_page.assert_not_called()


def test_bridge_key_with_no_state_entry_is_skipped(store):
    """A `[wrb_*]` handoff that isn't bound to a Notion page in bridge state
    must not raise — the bridge is a courier, not a self-creating ledger."""
    _upsert_handoff_from_fields(store, "wrb_aaaaaaaaaaaa")
    client = _make_client()
    pushed = sync_results(client, store=store)
    assert pushed == 0
    client.update_page.assert_not_called()
