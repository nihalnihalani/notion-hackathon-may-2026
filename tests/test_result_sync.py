"""Unit tests for src/result_sync.py (plan.md Task 7).

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

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.result_sync import parse_handoffs, sync_results  # noqa: E402
from src.state_store import StateStore, handoff_key_for_page  # noqa: E402


def _make_client():
    client = MagicMock()
    client.update_page.return_value = {"object": "page"}
    client.append_block_children.return_value = {
        "results": [{"id": "blk_result_1", "type": "code"}]
    }
    client.update_block.return_value = {"object": "block", "id": "blk_result_1"}
    return client


def _seed_dispatch(store: StateStore, page_id: str) -> str:
    key = handoff_key_for_page(page_id)
    store.mark_dispatched(
        key,
        page_id,
        context_path=f"/tmp/inbox/{key}.md",
        last_notion_status="Dispatched",
        last_local_status="PENDING",
        last_synced_at="2026-05-17T10:00:00Z",
        last_sync_hash="dispatch-hash",
    )
    return key


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


def test_completed_handoff_syncs_status_result_next_action(tmp_path):
    store = StateStore(tmp_path)
    key = _seed_dispatch(store, "page_aaa")
    (tmp_path / "HANDOFFS.md").write_text(
        f"- Task: t [{key}]\n"
        "  Owner: Hermes\n"
        "  Files Touched: **\n"
        "  Status: COMPLETED\n"
        "  Result: All clear\n"
        "  Next Action: None\n",
        encoding="utf-8",
    )
    client = _make_client()

    pushed = sync_results(client, tmp_path, store=store)

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
    persisted = store.load()["pages"]["page_aaa"]
    assert persisted["last_notion_status"] == "Completed"
    assert persisted["last_result_block_id"] == "blk_result_1"


def test_blocked_handoff_syncs_blocker(tmp_path):
    store = StateStore(tmp_path)
    key = _seed_dispatch(store, "page_bbb")
    (tmp_path / "HANDOFFS.md").write_text(
        f"- Task: t [{key}]\n"
        "  Owner: OpenClaw\n"
        "  Files Touched: **\n"
        "  Status: BLOCKED\n"
        "  Result: need credentials\n"
        "  Next Action: Provide PROD_TOKEN env var\n",
        encoding="utf-8",
    )
    client = _make_client()

    pushed = sync_results(client, tmp_path, store=store)
    assert pushed == 1
    props = client.update_page.call_args.args[1]
    assert props["Status"]["status"]["name"] == "Blocked"
    assert (
        props["Result Summary"]["rich_text"][0]["text"]["content"]
        == "need credentials"
    )


def test_unchanged_handoff_does_not_call_notion_again(tmp_path):
    store = StateStore(tmp_path)
    key = _seed_dispatch(store, "page_aaa")
    (tmp_path / "HANDOFFS.md").write_text(
        f"- Task: t [{key}]\n"
        "  Owner: Hermes\n"
        "  Files Touched: **\n"
        "  Status: COMPLETED\n"
        "  Result: Done\n"
        "  Next Action: None\n",
        encoding="utf-8",
    )
    client = _make_client()
    sync_results(client, tmp_path, store=store)
    client.reset_mock()

    pushed = sync_results(client, tmp_path, store=store)

    assert pushed == 0
    client.update_page.assert_not_called()
    client.append_block_children.assert_not_called()
    client.update_block.assert_not_called()


def test_changed_result_triggers_resync_and_block_update(tmp_path):
    store = StateStore(tmp_path)
    key = _seed_dispatch(store, "page_aaa")
    handoffs = tmp_path / "HANDOFFS.md"
    handoffs.write_text(
        f"- Task: t [{key}]\n"
        "  Owner: Hermes\n"
        "  Files Touched: **\n"
        "  Status: COMPLETED\n"
        "  Result: Done\n"
        "  Next Action: None\n",
        encoding="utf-8",
    )
    client = _make_client()
    sync_results(client, tmp_path, store=store)
    client.reset_mock()

    # Bump the result text and resync.
    handoffs.write_text(
        f"- Task: t [{key}]\n"
        "  Owner: Hermes\n"
        "  Files Touched: **\n"
        "  Status: COMPLETED\n"
        "  Result: Done with a follow-up note\n"
        "  Next Action: None\n",
        encoding="utf-8",
    )

    pushed = sync_results(client, tmp_path, store=store)
    assert pushed == 1
    client.update_page.assert_called_once()
    # Existing block updated in place; no new block appended.
    client.update_block.assert_called_once()
    client.append_block_children.assert_not_called()


def test_missing_bridge_key_is_ignored(tmp_path):
    store = StateStore(tmp_path)
    (tmp_path / "HANDOFFS.md").write_text(
        "- Task: Manual task with no bridge key\n"
        "  Owner: Hermes\n"
        "  Files Touched: **\n"
        "  Status: COMPLETED\n"
        "  Result: Done\n"
        "  Next Action: None\n",
        encoding="utf-8",
    )
    client = _make_client()
    pushed = sync_results(client, tmp_path, store=store)
    assert pushed == 0
    client.update_page.assert_not_called()


def test_bridge_key_with_no_state_entry_is_skipped(tmp_path):
    """A `[wrb_*]` key not present in state must not raise — the bridge is a
    courier, not a self-creating ledger."""
    store = StateStore(tmp_path)
    (tmp_path / "HANDOFFS.md").write_text(
        "- Task: orphan [wrb_aaaaaaaaaaaa]\n"
        "  Owner: Hermes\n"
        "  Files Touched: **\n"
        "  Status: COMPLETED\n"
        "  Result: Done\n"
        "  Next Action: None\n",
        encoding="utf-8",
    )
    client = _make_client()
    pushed = sync_results(client, tmp_path, store=store)
    assert pushed == 0
    client.update_page.assert_not_called()
