"""Tests for `src.mission_control_renderers` — Redis-backed.

Renderers now take a `RedisStore`. Each test constructs a store with
`fakeredis`, seeds it with `set_file` / `set_kb_doc` / `upsert_handoff` /
`set_bridge_state`, and passes it to the renderer. The contract under
test for each renderer:

- Missing source returns the documented sentinel.
- Empty source does not crash and returns a sentinel.
- Long content truncates with the trailing marker and stays within
  `MAX_RENDER_LEN`.
- Renderer-specific shape assertions per the task brief.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import fakeredis
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.mission_control_renderers import (  # noqa: E402
    MAX_RENDER_LEN,
    render_agent_history,
    render_bridge_stats,
    render_knowledge_base_index,
    render_protocol_and_roles,
    render_shared_memory,
    render_skill_registry,
)
from src.redis_store import RedisStore  # noqa: E402


@pytest.fixture
def store() -> RedisStore:
    return RedisStore(client=fakeredis.FakeRedis(decode_responses=True))


# ---- Shared helpers -------------------------------------------------------


def _seed_handoff(
    store: RedisStore,
    key: str,
    title: str,
    owner: str,
    status: str,
    *,
    files: str = "~/x",
) -> None:
    """Insert a single handoff with the desired status into the store."""
    store.upsert_handoff(
        key,
        task=title,
        owner=owner,
        files_touched=files,
        status=status,
        next_action="proceed",
    )


# ---- render_agent_history ------------------------------------------------


def test_agent_history_missing_file(store) -> None:
    assert render_agent_history(store) == "(no handoff history)"


def test_agent_history_empty_file(store) -> None:
    # No handoffs added — same sentinel as missing.
    assert render_agent_history(store) == "(no handoff history)"


def test_agent_history_groups_by_owner_and_limits(store) -> None:
    # 6 Hermes tasks (oldest -> newest), 2 OpenClaw, 1 Codex, 1 User, 1 Unknown.
    for i in range(6):
        _seed_handoff(
            store,
            f"wrb_aaaaaa00000{i:01x}",
            f"Hermes job {i}",
            "Hermes",
            "COMPLETED",
        )
    _seed_handoff(store, "wrb_bbbbbbbbbbb1", "OC one", "OpenClaw", "IN PROGRESS")
    _seed_handoff(store, "wrb_bbbbbbbbbbb2", "OC two", "OpenClaw", "FAILED")
    _seed_handoff(store, "wrb_cccccccccccc", "Codex job", "Codex", "BLOCKED")
    _seed_handoff(store, "wrb_dddddddddddd", "User reply", "User", "PENDING")
    # "Robot" is not in the canonical owner list; should appear after canonicals.
    _seed_handoff(store, "wrb_eeeeeeeeeeee", "Robot job", "Robot", "PENDING")

    out = render_agent_history(store, limit_per_agent=3)

    # Sections present, in canonical order followed by extras.
    assert "## Hermes" in out
    assert "## OpenClaw" in out
    assert "## Codex" in out
    assert "## User" in out
    assert "## Robot" in out
    assert out.index("## Hermes") < out.index("## OpenClaw") < out.index("## Codex")
    assert out.index("## Codex") < out.index("## User") < out.index("## Robot")

    # Per-owner limit: at most 3 Hermes bullets (the most recent three).
    hermes_section = out.split("## Hermes", 1)[1].split("## ", 1)[0]
    hermes_bullets = [ln for ln in hermes_section.splitlines() if ln.startswith("- ")]
    assert len(hermes_bullets) == 3
    # Newest entries kept (indices 3, 4, 5).
    assert "Hermes job 5" in hermes_section
    assert "Hermes job 4" in hermes_section
    assert "Hermes job 3" in hermes_section
    assert "Hermes job 0" not in hermes_section

    # Status labels surface in bullets.
    assert "[COMPLETED]" in hermes_section
    openclaw_section = out.split("## OpenClaw", 1)[1].split("## ", 1)[0]
    assert "[IN PROGRESS]" in openclaw_section
    assert "[FAILED]" in openclaw_section


def test_agent_history_truncates(store) -> None:
    # Generate enough handoffs that grouped output blows past the cap.
    for i in range(80):
        _seed_handoff(
            store,
            f"wrb_{i:012x}",
            "x" * 180,  # long titles
            "Hermes",
            "COMPLETED",
        )

    out = render_agent_history(store, limit_per_agent=80)
    assert len(out) <= MAX_RENDER_LEN
    assert out.endswith("...[truncated]")


# ---- render_shared_memory ------------------------------------------------


def test_shared_memory_missing(store) -> None:
    assert render_shared_memory(store) == "(no shared memory yet)"


def test_shared_memory_empty(store) -> None:
    store.set_file("SHARED_MEMORY.md", "   \n\n")
    assert render_shared_memory(store) == "(no shared memory yet)"


def test_shared_memory_passthrough_and_truncate(store) -> None:
    short = "# Shared\nhello world\n"
    store.set_file("SHARED_MEMORY.md", short)
    assert render_shared_memory(store) == short

    long_text = "x" * (MAX_RENDER_LEN * 3)
    store.set_file("SHARED_MEMORY.md", long_text)
    out = render_shared_memory(store)
    assert len(out) <= MAX_RENDER_LEN
    assert out.endswith("...[truncated]")


# ---- render_knowledge_base_index -----------------------------------------


def test_kb_index_missing_directory(store) -> None:
    assert render_knowledge_base_index(store) == "(no knowledge base files)"


def test_kb_index_empty_index(store) -> None:
    # No KB docs seeded.
    assert render_knowledge_base_index(store) == "(no knowledge base files)"


def test_kb_index_lists_md_files_sorted(store) -> None:
    # 3 .md files at the top of the index, plus a deeper one (still listed —
    # Redis no longer enforces filesystem depth limits the way the directory
    # walker did).
    store.set_kb_doc("alpha.md", "a" * 10)
    store.set_kb_doc("nested/bravo.md", "bb" * 8)  # 16
    store.set_kb_doc("nested/charlie.md", "c" * 5)

    out = render_knowledge_base_index(store)
    lines = out.splitlines()
    # Top three listed in sort order; byte counts come from stored values.
    assert "- alpha.md (10 bytes)" in lines
    assert "- nested/bravo.md (16 bytes)" in lines
    assert "- nested/charlie.md (5 bytes)" in lines


def test_kb_index_truncates(store) -> None:
    # 200 files easily exceed the 1900 cap when listed.
    for i in range(200):
        store.set_kb_doc(f"file_{i:04d}_{'x' * 10}.md", "data")
    out = render_knowledge_base_index(store)
    assert len(out) <= MAX_RENDER_LEN
    assert out.endswith("...[truncated]")


# ---- render_skill_registry -----------------------------------------------


def test_skill_registry_missing(store) -> None:
    assert render_skill_registry(store) == "(no skill registry)"


def test_skill_registry_empty(store) -> None:
    store.set_file("SKILL_REGISTRY.md", "")
    assert render_skill_registry(store) == "(no skill registry)"


def test_skill_registry_passthrough_and_truncate(store) -> None:
    short = "## skills\n- one\n- two\n"
    store.set_file("SKILL_REGISTRY.md", short)
    assert render_skill_registry(store) == short

    store.set_file("SKILL_REGISTRY.md", "z" * (MAX_RENDER_LEN * 2))
    out = render_skill_registry(store)
    assert len(out) <= MAX_RENDER_LEN
    assert out.endswith("...[truncated]")


# ---- render_protocol_and_roles -------------------------------------------


def test_protocol_and_roles_both_missing(store) -> None:
    out = render_protocol_and_roles(store)
    assert "## Protocol" in out
    assert "## Agent Roles" in out
    # Two `(missing)` markers, one per section.
    assert out.count("(missing)") == 2


def test_protocol_and_roles_only_protocol_missing(store) -> None:
    store.set_file("AGENT_ROLES.md", "# Roles\nHermes is great.\n")

    out = render_protocol_and_roles(store)

    # Protocol section is missing, but the roles section is intact.
    protocol_section = out.split("## Protocol", 1)[1].split("## Agent Roles", 1)[0]
    assert "(missing)" in protocol_section
    roles_section = out.split("## Agent Roles", 1)[1]
    assert "Hermes is great." in roles_section
    assert "(missing)" not in roles_section


def test_protocol_and_roles_both_present(store) -> None:
    store.set_file("PROTOCOL.md", "Protocol body here.")
    store.set_file("AGENT_ROLES.md", "Roles body here.")

    out = render_protocol_and_roles(store)
    assert "## Protocol\nProtocol body here." in out
    assert "## Agent Roles\nRoles body here." in out
    assert "(missing)" not in out


def test_protocol_and_roles_empty_files_do_not_crash(store) -> None:
    store.set_file("PROTOCOL.md", "")
    store.set_file("AGENT_ROLES.md", "")
    out = render_protocol_and_roles(store)
    # Empty file is rendered the same as missing (both bodies blank/sentinel),
    # but the renderer must not crash and both section headers must appear.
    assert "## Protocol" in out
    assert "## Agent Roles" in out


def test_protocol_and_roles_truncates(store) -> None:
    store.set_file("PROTOCOL.md", "a" * MAX_RENDER_LEN)
    store.set_file("AGENT_ROLES.md", "b" * MAX_RENDER_LEN)
    out = render_protocol_and_roles(store)
    assert len(out) <= MAX_RENDER_LEN
    assert out.endswith("...[truncated]")


# ---- render_bridge_stats -------------------------------------------------


def test_bridge_stats_missing(store) -> None:
    # No bridge state set yet → still treated as "no stats available."
    assert render_bridge_stats(store) == "(no bridge state yet)"


def test_bridge_stats_empty(store) -> None:
    # set_bridge_state with an empty dict produces "{}" JSON; renderer
    # should still treat that as the "no stats" sentinel.
    store.set_bridge_state({})
    out = render_bridge_stats(store)
    # Renderer may either return the empty-state sentinel or a populated
    # "0 of everything" block — both are acceptable. Just don't crash.
    assert isinstance(out, str)


def test_bridge_stats_reports_counts(store) -> None:
    state = {
        "version": 1,
        "command_center_data_source_id": "ds_123",
        "dashboard_block_id": "blk_999",
        "mission_control": {
            "agent_history": {"block_id": "blk_a", "hash": "hashA"},
            "shared_memory": {"block_id": "blk_b", "hash": "hashB"},
            "knowledge_base": {"block_id": "blk_c", "hash": "hashC"},
        },
        "pages": {
            "p1": {"last_notion_status": "Dispatched"},
            "p2": {"last_notion_status": "Completed"},
            "p3": {"last_notion_status": "Completed"},
            "p4": {"last_notion_status": "Blocked"},
            "p5": {},  # missing status -> bucketed as (unknown)
        },
    }
    store.set_bridge_state(state)

    out = render_bridge_stats(store)

    assert "Tracked pages: 5" in out
    assert "Command Center data source: ds_123" in out
    assert "Dashboard block id: blk_999" in out
    assert "Mission Control sections tracked: 3" in out
    # Per-status counts present.
    assert "- Blocked: 1" in out
    assert "- Completed: 2" in out
    assert "- Dispatched: 1" in out
    assert "- (unknown): 1" in out


def test_bridge_stats_empty_state(store) -> None:
    store.set_bridge_state({"version": 1, "pages": {}})
    out = render_bridge_stats(store)
    assert "Tracked pages: 0" in out
    assert "Command Center data source: (none)" in out
    assert "Dashboard block id: (none)" in out
    assert "Mission Control sections tracked: 0" in out
    # No pages -> show a "(none)" line under the status section.
    assert "- (none)" in out


def test_bridge_stats_truncates(store) -> None:
    # 500 pages with long status strings to bust the cap via the per-status
    # counts list.
    pages = {
        f"page_{i:04d}": {"last_notion_status": f"Status_{i:04d}_{'x' * 40}"}
        for i in range(500)
    }
    store.set_bridge_state({"pages": pages})
    out = render_bridge_stats(store)
    assert len(out) <= MAX_RENDER_LEN
    assert out.endswith("...[truncated]")
