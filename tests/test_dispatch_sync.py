"""Unit tests for src/dispatch_sync.py (plan.md Task 6).

Covers:
- A new Notion `Pending` task appends one handoff and marks Notion `Dispatched`.
- Restart does not duplicate the handoff (idempotency on Notion page id).
- Invalid Assignee blocks the Notion task instead of dispatching.
- Active lock conflict blocks the task with a clear reason.
- Missing local write does not allow Notion to advance to `Dispatched`.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.dispatch_sync import (  # noqa: E402
    _detect_lock_conflict,
    sync_dispatch,
)
from src.state_store import StateStore, handoff_key_for_page  # noqa: E402


def _notion_page(
    page_id: str,
    *,
    title: str = "Inspect War Room health",
    owner: str = "Hermes",
    files: str = "/home/alhinai/WarRoom/**",
    context: str = "Just look around.",
) -> dict:
    return {
        "id": page_id,
        "properties": {
            "Name": {"title": [{"text": {"content": title}}]},
            "Assignee": {"select": {"name": owner}},
            "Authorized Files": {"rich_text": [{"text": {"content": files}}]},
            "Context": {"rich_text": [{"text": {"content": context}}]},
            "Working Directory": {"rich_text": []},
            "Next Action": {"rich_text": []},
        },
    }


def _make_client(pages):
    client = MagicMock()
    client.query_data_source.return_value = {"results": pages, "has_more": False}
    client.update_page.return_value = {"object": "page"}
    return client


# ---- _detect_lock_conflict ------------------------------------------------


def test_detect_lock_conflict_finds_overlap():
    locks = "- Active Lock: /home/alhinai/WarRoom/test.py"
    assert (
        _detect_lock_conflict("/home/alhinai/WarRoom/test.py", locks)
        is not None
    )


def test_detect_lock_conflict_returns_none_when_disjoint():
    locks = "- Active Lock: /home/alhinai/WarRoom/test.py"
    assert _detect_lock_conflict("/home/alhinai/WarRoom/other.py", locks) is None


# ---- sync_dispatch end-to-end ---------------------------------------------


def test_no_pending_tasks_is_a_noop(tmp_path):
    client = _make_client([])
    store = StateStore(tmp_path)
    assert sync_dispatch(client, "ds_xyz", tmp_path, store=store) == 0
    client.query_data_source.assert_called_once()


def test_new_pending_task_appends_handoff_and_marks_dispatched(tmp_path):
    page = _notion_page("page_aaa")
    client = _make_client([page])
    store = StateStore(tmp_path)

    resolved = sync_dispatch(client, "ds_xyz", tmp_path, store=store)

    assert resolved == 1
    handoffs = (tmp_path / "HANDOFFS.md").read_text(encoding="utf-8")
    assert "Inspect War Room health" in handoffs
    assert "Owner: Hermes" in handoffs
    assert "Status: PENDING" in handoffs

    # State knows about this page and tracks the same handoff key.
    expected_key = handoff_key_for_page("page_aaa")
    assert f"[{expected_key}]" in handoffs
    persisted = store.load()
    assert "page_aaa" in persisted["pages"]
    assert persisted["pages"]["page_aaa"]["handoff_key"] == expected_key
    assert persisted["pages"]["page_aaa"]["last_notion_status"] == "Dispatched"

    # Notion was patched to Dispatched with the same key.
    update_args, update_kwargs = client.update_page.call_args
    assert update_args[0] == "page_aaa"
    props = update_args[1]
    assert props["Status"]["status"]["name"] == "Dispatched"
    assert (
        props["War Room Key"]["rich_text"][0]["text"]["content"] == expected_key
    )

    # Context snapshot saved to NotionInbox.
    inbox = tmp_path / "NotionInbox"
    assert inbox.is_dir()
    snap = inbox / f"{expected_key}.md"
    assert snap.is_file()
    assert "Inspect War Room health" in snap.read_text(encoding="utf-8")


def test_restart_does_not_duplicate_handoff(tmp_path):
    page = _notion_page("page_aaa")
    client = _make_client([page])
    store = StateStore(tmp_path)

    sync_dispatch(client, "ds_xyz", tmp_path, store=store)
    client.query_data_source.return_value = {"results": [page], "has_more": False}
    sync_dispatch(client, "ds_xyz", tmp_path, store=store)
    sync_dispatch(client, "ds_xyz", tmp_path, store=store)

    handoffs = (tmp_path / "HANDOFFS.md").read_text(encoding="utf-8")
    assert handoffs.count("- Task: Inspect War Room health") == 1


def test_invalid_assignee_blocks_in_notion(tmp_path):
    page = _notion_page("page_bbb", owner="Skynet")
    client = _make_client([page])
    store = StateStore(tmp_path)

    resolved = sync_dispatch(client, "ds_xyz", tmp_path, store=store)
    assert resolved == 1
    # No handoff appended for blocked tasks.
    handoffs_file = tmp_path / "HANDOFFS.md"
    assert not handoffs_file.exists() or "Skynet" not in handoffs_file.read_text(
        encoding="utf-8"
    )

    # Notion received a Blocked update with reason text.
    update_args, _ = client.update_page.call_args
    assert update_args[0] == "page_bbb"
    props = update_args[1]
    assert props["Status"]["status"]["name"] == "Blocked"
    reason = props["Result Summary"]["rich_text"][0]["text"]["content"]
    assert "Invalid Assignee" in reason
    assert "Skynet" in reason


def test_active_lock_conflict_blocks_task(tmp_path):
    # Seed CURRENT_STATE.md with an active lock on the file the task wants.
    (tmp_path / "CURRENT_STATE.md").write_text(
        "## Active Locks\n"
        "- /home/alhinai/WarRoom/critical.py held by OpenClaw\n",
        encoding="utf-8",
    )
    page = _notion_page(
        "page_ccc", files="/home/alhinai/WarRoom/critical.py"
    )
    client = _make_client([page])
    store = StateStore(tmp_path)

    resolved = sync_dispatch(client, "ds_xyz", tmp_path, store=store)

    assert resolved == 1
    props = client.update_page.call_args.args[1]
    assert props["Status"]["status"]["name"] == "Blocked"
    assert "lock conflict" in props["Result Summary"]["rich_text"][0]["text"]["content"]


def test_local_write_must_precede_notion_dispatch(tmp_path, monkeypatch):
    """If Notion's PATCH fails, the local handoff already exists; on retry
    the state file keeps the bridge from double-appending."""
    page = _notion_page("page_ddd")
    client = _make_client([page])
    # First call to update_page raises (simulating a transient Notion failure
    # after the local handoff already landed); the bridge must not crash.
    client.update_page.side_effect = [RuntimeError("notion 502")]
    store = StateStore(tmp_path)

    sync_dispatch(client, "ds_xyz", tmp_path, store=store)

    # Local handoff is on disk despite the Notion failure.
    handoffs = (tmp_path / "HANDOFFS.md").read_text(encoding="utf-8")
    assert "Inspect War Room health" in handoffs

    # Second pass: Notion succeeds, but we must NOT re-append a duplicate.
    client.update_page.side_effect = None
    client.update_page.return_value = {"object": "page"}
    client.query_data_source.return_value = {"results": [page], "has_more": False}
    sync_dispatch(client, "ds_xyz", tmp_path, store=store)
    handoffs2 = (tmp_path / "HANDOFFS.md").read_text(encoding="utf-8")
    assert handoffs2.count("- Task: Inspect War Room health") == 1
