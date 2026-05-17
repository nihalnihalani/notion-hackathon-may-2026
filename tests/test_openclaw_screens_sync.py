"""Tests for src/openclaw_screens_sync.py — bidirectional sync, Redis-backed.

Covers:
- First-run bootstrap creates the editable block from local content.
- Hash-skip when nothing changed on either side.
- Local-changed → push to Notion.
- Notion-changed → pull to local (store write).
- Both changed → last-edit-wins by timestamp.
- 404 on the editable block recreates it once.
- Read-only screens (Docs, Visual Office) follow the existing
  upsert pattern.
- The one-shot Command Center linker is idempotent.

The bidirectional flow compares `last_local_updated_at` (from bridge state)
with Notion's `last_edited_time`, since the canonical local content lives
in Redis and has no filesystem mtime.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import fakeredis
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.notion_http import NotionAPIError  # noqa: E402
from src.openclaw_screens_sync import (  # noqa: E402
    BidirectionalSpec,
    _extract_block_text,
    _last_activity_per_owner,
    _parse_notion_ts,
    _sync_one_bidirectional,
    link_tasks_page_to_command_center,
    render_docs_screen,
    render_visual_office,
    sync_openclaw_screens,
)
from src.redis_store import RedisStore  # noqa: E402


@pytest.fixture
def store() -> RedisStore:
    return RedisStore(client=fakeredis.FakeRedis(decode_responses=True))


# ---- low-level helpers ---------------------------------------------------


def test_extract_block_text_handles_code_paragraph_quote():
    code_block = {"code": {"rich_text": [{"text": {"content": "hello"}}]}}
    assert _extract_block_text(code_block) == "hello"
    paragraph = {"paragraph": {"rich_text": [{"text": {"content": "p"}}]}}
    assert _extract_block_text(paragraph) == "p"
    quote = {"quote": {"rich_text": [{"text": {"content": "q"}}]}}
    assert _extract_block_text(quote) == "q"
    assert _extract_block_text({}) == ""


def test_parse_notion_ts_round_trip():
    parsed = _parse_notion_ts("2026-05-17T12:34:56.000Z")
    assert parsed is not None
    assert parsed.tzinfo is not None


def test_parse_notion_ts_empty_returns_none():
    assert _parse_notion_ts(None) is None
    assert _parse_notion_ts("") is None
    assert _parse_notion_ts("not-a-date") is None


# ---- render_docs (read-only derived) ------------------------------------


def test_render_docs_missing_dir(store):
    # Nothing in the KB index yet — renderer emits a clear empty-state sentinel.
    out = render_docs_screen(store)
    assert "Live Docs" in out
    assert "no .md files" in out.lower() or "no knowledgebase" in out.lower()


def test_render_docs_lists_md_files_sorted(store):
    store.set_kb_doc("alpha.md", "a")
    store.set_kb_doc("beta.md", "bb")
    out = render_docs_screen(store)
    assert "alpha.md (1 bytes)" in out
    assert "beta.md (2 bytes)" in out
    assert out.index("alpha.md") < out.index("beta.md")


# ---- render_visual_office (read-only derived) ---------------------------


def test_visual_office_no_activity(store):
    out = render_visual_office(store)
    assert "no agent activity recorded yet" in out


def test_visual_office_status_badges(store):
    # Three handoffs with different owners, last_updated_at varying.
    store.upsert_handoff(
        "wrb_aaaaaaaaaaaa",
        task="A",
        owner="Hermes",
        files_touched="x",
        status="COMPLETED",
        result="ok",
        next_action="None",
        last_updated_at="2026-05-17T12:00:00Z",
    )
    store.upsert_handoff(
        "wrb_bbbbbbbbbbbb",
        task="B",
        owner="OpenClaw",
        files_touched="x",
        status="COMPLETED",
        result="ok",
        next_action="None",
        last_updated_at="2026-05-17T11:30:00Z",
    )
    store.upsert_handoff(
        "wrb_cccccccccccc",
        task="C",
        owner="Codex",
        files_touched="x",
        status="COMPLETED",
        result="ok",
        next_action="None",
        last_updated_at="2026-05-17T05:00:00Z",
    )
    # Mirror the per-page state so renderers depending on bridge state can
    # derive activity buckets.
    state = store.get_bridge_state()
    state["pages"] = {
        "p1": {
            "handoff_key": "wrb_aaaaaaaaaaaa",
            "last_synced_at": "2026-05-17T12:00:00Z",
        },
        "p2": {
            "handoff_key": "wrb_bbbbbbbbbbbb",
            "last_synced_at": "2026-05-17T11:30:00Z",
        },
        "p3": {
            "handoff_key": "wrb_cccccccccccc",
            "last_synced_at": "2026-05-17T05:00:00Z",
        },
    }
    store.set_bridge_state(state)

    now = datetime(2026, 5, 17, 12, 2, 0, tzinfo=timezone.utc)
    out = render_visual_office(store, now=now)
    assert "🟢 ACTIVE" in out  # Hermes (2 min ago)
    assert "🟡 IDLE" in out  # OpenClaw (~32 min ago)
    assert "⚫ AWAY" in out  # Codex (~7 h ago)


# ---- Bidirectional sync ----------------------------------------------


def _spec(file_name: str = "TEST.md") -> BidirectionalSpec:
    return BidirectionalSpec(screen_key="screen_test", local_file=file_name)


def _seed_page(store: RedisStore, screen_key: str, page_id: str = "page_x") -> None:
    state = store.get_bridge_state()
    state.setdefault("openclaw_pages", {})[screen_key] = {"page_id": page_id}
    store.set_bridge_state(state)


def _set_local_updated_at(store: RedisStore, screen_key: str, iso_ts: str) -> None:
    state = store.get_bridge_state()
    entry = state.setdefault("openclaw_pages", {}).setdefault(screen_key, {})
    entry["last_local_updated_at"] = iso_ts
    store.set_bridge_state(state)


def _make_client(
    *,
    append_id: str = "blk_new",
    get_text: str = "",
    get_last_edited: str = "2026-05-17T00:00:00.000Z",
) -> MagicMock:
    client = MagicMock()
    client.append_block_children.return_value = {"results": [{"id": append_id}]}
    client.get_block.return_value = {
        "object": "block",
        "id": "blk_x",
        "code": {"rich_text": [{"text": {"content": get_text}}]},
        "last_edited_time": get_last_edited,
    }
    client.update_block.return_value = {"object": "block"}
    return client


def test_first_run_bootstraps_block_from_local_content(store):
    store.set_file("TEST.md", "hello local\n")
    _seed_page(store, "screen_test")
    client = _make_client(append_id="blk_created")

    outcome = _sync_one_bidirectional(
        client, _spec(), "page_x", None, store
    )

    assert outcome == "created"
    client.append_block_children.assert_called_once()
    client.update_block.assert_not_called()
    entry = store.get_bridge_state()["openclaw_pages"]["screen_test"]
    assert entry["live_block_id"] == "blk_created"
    assert isinstance(entry["live_hash"], str) and len(entry["live_hash"]) == 64


def test_unchanged_no_api_mutation(store):
    store.set_file("TEST.md", "same\n")
    _seed_page(store, "screen_test")
    client = _make_client(append_id="blk_1", get_text="same\n")
    _sync_one_bidirectional(
        client, _spec(), "page_x", None, store
    )
    client.reset_mock()

    block_id = store.get_bridge_state()["openclaw_pages"]["screen_test"][
        "live_block_id"
    ]
    outcome = _sync_one_bidirectional(
        client,
        _spec(),
        "page_x",
        block_id,
        store,
    )
    assert outcome == "unchanged"
    client.update_block.assert_not_called()
    client.append_block_children.assert_not_called()


def test_local_changed_pushes_to_notion(store):
    store.set_file("TEST.md", "v1")
    _seed_page(store, "screen_test")
    client = _make_client(append_id="blk_1", get_text="v1")
    _sync_one_bidirectional(
        client, _spec(), "page_x", None, store
    )
    client.reset_mock()

    store.set_file("TEST.md", "v2 — local edit")
    # Local edit time is now; remote is older.
    _set_local_updated_at(
        store, "screen_test", datetime.now(timezone.utc).isoformat()
    )
    client.get_block.return_value = {
        "id": "blk_1",
        "code": {"rich_text": [{"text": {"content": "v1"}}]},  # remote unchanged
        "last_edited_time": "2026-05-17T00:00:00.000Z",
    }
    outcome = _sync_one_bidirectional(
        client, _spec(), "page_x", "blk_1", store
    )

    assert outcome == "pushed"
    client.update_block.assert_called_once()
    args, _kw = client.update_block.call_args
    assert args[0] == "blk_1"
    assert "v2 — local edit" in args[1]["code"]["rich_text"][0]["text"]["content"]


def test_remote_changed_pulls_to_local(store):
    store.set_file("TEST.md", "v1")
    _seed_page(store, "screen_test")
    client = _make_client(append_id="blk_1", get_text="v1")
    _sync_one_bidirectional(client, _spec(), "page_x", None, store)
    client.reset_mock()

    # Local unchanged; remote was edited.
    client.get_block.return_value = {
        "id": "blk_1",
        "code": {"rich_text": [{"text": {"content": "v2 from notion"}}]},
        "last_edited_time": "2026-05-17T12:00:00.000Z",
    }
    outcome = _sync_one_bidirectional(
        client, _spec(), "page_x", "blk_1", store
    )

    assert outcome == "pulled"
    assert store.get_file("TEST.md") == "v2 from notion"
    client.update_block.assert_not_called()


def test_both_changed_local_wins_when_local_newer(store):
    store.set_file("TEST.md", "v1")
    _seed_page(store, "screen_test")
    client = _make_client(append_id="blk_1", get_text="v1")
    _sync_one_bidirectional(client, _spec(), "page_x", None, store)
    client.reset_mock()

    # Local edited to "L2" (last_local_updated_at = now). Remote edited to
    # "R2" but Notion says it was edited well in the past — local wins.
    store.set_file("TEST.md", "L2")
    _set_local_updated_at(
        store, "screen_test", datetime.now(timezone.utc).isoformat()
    )
    client.get_block.return_value = {
        "id": "blk_1",
        "code": {"rich_text": [{"text": {"content": "R2"}}]},
        "last_edited_time": "2026-05-16T00:00:00.000Z",  # past
    }
    outcome = _sync_one_bidirectional(
        client, _spec(), "page_x", "blk_1", store
    )

    assert outcome == "conflict_local"
    client.update_block.assert_called_once()
    args, _ = client.update_block.call_args
    assert "L2" in args[1]["code"]["rich_text"][0]["text"]["content"]
    assert store.get_file("TEST.md") == "L2"


def test_both_changed_remote_wins_when_notion_newer(store):
    store.set_file("TEST.md", "v1")
    _seed_page(store, "screen_test")
    client = _make_client(append_id="blk_1", get_text="v1")
    _sync_one_bidirectional(client, _spec(), "page_x", None, store)
    client.reset_mock()

    # Local edited to "L2" but with a stale last_local_updated_at (~1 hour
    # ago); remote edit is in the far future — remote wins.
    store.set_file("TEST.md", "L2")
    old = (
        datetime.now(timezone.utc).timestamp() - 3600
    )
    old_iso = datetime.fromtimestamp(old, tz=timezone.utc).isoformat()
    _set_local_updated_at(store, "screen_test", old_iso)
    future = "2099-01-01T00:00:00.000Z"
    client.get_block.return_value = {
        "id": "blk_1",
        "code": {"rich_text": [{"text": {"content": "R2"}}]},
        "last_edited_time": future,
    }
    outcome = _sync_one_bidirectional(
        client, _spec(), "page_x", "blk_1", store
    )

    assert outcome == "conflict_remote"
    assert store.get_file("TEST.md") == "R2"
    client.update_block.assert_not_called()


def test_404_on_get_block_recreates_from_local(store):
    store.set_file("TEST.md", "v1")
    _seed_page(store, "screen_test")
    client = _make_client(append_id="blk_old", get_text="v1")
    _sync_one_bidirectional(client, _spec(), "page_x", None, store)
    client.reset_mock()

    # Notion deleted the block; get_block raises 404.
    client.get_block.side_effect = NotionAPIError(404, "Not Found")
    client.append_block_children.return_value = {"results": [{"id": "blk_recreated"}]}
    outcome = _sync_one_bidirectional(
        client, _spec(), "page_x", "blk_old", store
    )

    assert outcome == "created"
    client.append_block_children.assert_called_once()
    assert (
        store.get_bridge_state()["openclaw_pages"]["screen_test"]["live_block_id"]
        == "blk_recreated"
    )


# ---- End-to-end sync_openclaw_screens --------------------------------


def test_sync_e2e_creates_one_block_per_wired_screen(store):
    """All wired screen pages get their first live block on a cold run."""
    store.set_file("SHARED_MEMORY.md", "memory\n")
    store.set_file("AGENT_ROLES.md", "roles\n")
    store.set_file("SCHEDULE.md", "schedule\n")
    store.set_file("PROJECTS.md", "projects\n")
    store.set_file("HANDOFFS.md", "")
    store.set_kb_doc("x.md", "doc")

    for screen in (
        "screen_memory",
        "screen_calendar",
        "screen_team",
        "screen_projects",
        "screen_docs",
        "screen_visual_office",
    ):
        _seed_page(store, screen, page_id=f"page_{screen}")

    ids = iter([f"blk_{i}" for i in range(20)])
    client = MagicMock()
    client.append_block_children.side_effect = lambda page, children: {
        "results": [{"id": next(ids)}]
    }
    client.get_block.return_value = {
        "code": {"rich_text": [{"text": {"content": ""}}]},
        "last_edited_time": "2026-05-17T00:00:00.000Z",
    }
    client.update_block.return_value = {}

    pushed = sync_openclaw_screens(client, store)
    # 4 bidirectional + 2 readonly = 6 first-run mutations.
    assert pushed == 6


# ---- Linker ----------------------------------------------------------


def test_link_tasks_page_requires_page_in_state(store):
    client = MagicMock()
    assert link_tasks_page_to_command_center(client, "db_xyz", store) is False
    client.append_block_children.assert_not_called()


def test_link_tasks_page_appends_once(store):
    _seed_page(store, "screen_tasks", page_id="tasks_p")
    client = MagicMock()
    client.append_block_children.return_value = {"results": [{"id": "blk_link"}]}

    assert link_tasks_page_to_command_center(client, "db_xyz", store) is True
    args, _ = client.append_block_children.call_args
    block = args[1][0]
    assert block["type"] == "link_to_page"
    assert block["link_to_page"]["database_id"] == "db_xyz"

    # Second call: no-op (state flag guards against duplicate links).
    client.reset_mock()
    assert link_tasks_page_to_command_center(client, "db_xyz", store) is False
    client.append_block_children.assert_not_called()


# ---- Per-Owner activity helper ---------------------------------------


def test_last_activity_per_owner_groups_by_newest(store):
    store.upsert_handoff(
        "wrb_aaaaaaaaaaaa",
        task="A",
        owner="Hermes",
        files_touched="x",
        status="COMPLETED",
        result="ok",
        next_action="None",
    )
    store.upsert_handoff(
        "wrb_bbbbbbbbbbbb",
        task="B",
        owner="Hermes",
        files_touched="x",
        status="IN PROGRESS",
        result="",
        next_action="continue",
    )
    state = store.get_bridge_state()
    state["pages"] = {
        "p1": {
            "handoff_key": "wrb_aaaaaaaaaaaa",
            "last_synced_at": "2026-05-17T10:00:00Z",
        },
        "p2": {
            "handoff_key": "wrb_bbbbbbbbbbbb",
            "last_synced_at": "2026-05-17T12:00:00Z",
        },
    }
    store.set_bridge_state(state)

    activity = _last_activity_per_owner(store)
    assert activity["Hermes"] == "2026-05-17T12:00:00Z"
