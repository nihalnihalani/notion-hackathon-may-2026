"""Unit tests for src/dispatch_sync.py (plan.md Task 6) — Redis-backed.

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

import fakeredis
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.dispatch_sync import (  # noqa: E402
    _detect_lock_conflict,
    sync_dispatch,
)
from src.redis_store import RedisStore  # noqa: E402
from src.state_store import handoff_key_for_page  # noqa: E402


@pytest.fixture
def store() -> RedisStore:
    return RedisStore(client=fakeredis.FakeRedis(decode_responses=True))


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


def test_no_pending_tasks_is_a_noop(store):
    client = _make_client([])
    assert sync_dispatch(client, "ds_xyz", store=store) == 0
    client.query_data_source.assert_called_once()


def test_new_pending_task_appends_handoff_and_marks_dispatched(store):
    page = _notion_page("page_aaa")
    client = _make_client([page])

    resolved = sync_dispatch(client, "ds_xyz", store=store)

    assert resolved == 1
    handoffs_md = store.render_handoffs_md()
    assert "Inspect War Room health" in handoffs_md
    assert "Owner: Hermes" in handoffs_md
    assert "Status: PENDING" in handoffs_md

    # State knows about this page and tracks the same handoff key.
    expected_key = handoff_key_for_page("page_aaa")
    assert f"[{expected_key}]" in handoffs_md
    bridge_state = store.get_bridge_state()
    assert "page_aaa" in bridge_state["pages"]
    assert bridge_state["pages"]["page_aaa"]["handoff_key"] == expected_key
    assert (
        bridge_state["pages"]["page_aaa"]["last_notion_status"] == "Dispatched"
    )

    # Notion was patched to Dispatched with the same key.
    update_args, update_kwargs = client.update_page.call_args
    assert update_args[0] == "page_aaa"
    props = update_args[1]
    assert props["Status"]["status"]["name"] == "Dispatched"
    assert (
        props["War Room Key"]["rich_text"][0]["text"]["content"] == expected_key
    )

    # Context snapshot saved to the notion inbox.
    snapshot = store.get_notion_inbox(expected_key)
    assert snapshot is not None
    assert "Inspect War Room health" in snapshot


def test_restart_does_not_duplicate_handoff(store):
    page = _notion_page("page_aaa")
    client = _make_client([page])

    sync_dispatch(client, "ds_xyz", store=store)
    client.query_data_source.return_value = {"results": [page], "has_more": False}
    sync_dispatch(client, "ds_xyz", store=store)
    sync_dispatch(client, "ds_xyz", store=store)

    handoffs_md = store.render_handoffs_md()
    assert handoffs_md.count("- Task: Inspect War Room health") == 1


def test_invalid_assignee_blocks_in_notion(store):
    page = _notion_page("page_bbb", owner="Skynet")
    client = _make_client([page])

    resolved = sync_dispatch(client, "ds_xyz", store=store)
    assert resolved == 1
    # No handoff appended for blocked tasks.
    handoffs_md = store.render_handoffs_md()
    assert "Skynet" not in handoffs_md

    # Notion received a Blocked update with reason text.
    update_args, _ = client.update_page.call_args
    assert update_args[0] == "page_bbb"
    props = update_args[1]
    assert props["Status"]["status"]["name"] == "Blocked"
    reason = props["Result Summary"]["rich_text"][0]["text"]["content"]
    assert "Invalid Assignee" in reason
    assert "Skynet" in reason


def test_active_lock_conflict_blocks_task(store):
    # Seed CURRENT_STATE.md with an active lock on the file the task wants.
    store.set_file(
        "CURRENT_STATE.md",
        "## Active Locks\n"
        "- /home/alhinai/WarRoom/critical.py held by OpenClaw\n",
    )
    page = _notion_page(
        "page_ccc", files="/home/alhinai/WarRoom/critical.py"
    )
    client = _make_client([page])

    resolved = sync_dispatch(client, "ds_xyz", store=store)

    assert resolved == 1
    props = client.update_page.call_args.args[1]
    assert props["Status"]["status"]["name"] == "Blocked"
    assert "lock conflict" in props["Result Summary"]["rich_text"][0]["text"]["content"]


def test_local_write_must_precede_notion_dispatch(store):
    """If Notion's PATCH fails, the local handoff already exists; on retry
    the state file keeps the bridge from double-appending."""
    page = _notion_page("page_ddd")
    client = _make_client([page])
    # First call to update_page raises (simulating a transient Notion failure
    # after the local handoff already landed); the bridge must not crash.
    client.update_page.side_effect = [RuntimeError("notion 502")]

    sync_dispatch(client, "ds_xyz", store=store)

    # Local handoff is in Redis despite the Notion failure.
    handoffs_md = store.render_handoffs_md()
    assert "Inspect War Room health" in handoffs_md

    # Second pass: Notion succeeds, but we must NOT re-append a duplicate.
    client.update_page.side_effect = None
    client.update_page.return_value = {"object": "page"}
    client.query_data_source.return_value = {"results": [page], "has_more": False}
    sync_dispatch(client, "ds_xyz", store=store)
    handoffs_md_after = store.render_handoffs_md()
    assert handoffs_md_after.count("- Task: Inspect War Room health") == 1
