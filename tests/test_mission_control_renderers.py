"""Tests for `src.mission_control_renderers`.

Renderers are pure file readers, so every test uses `tmp_path` fixtures and
no mocks. The contract under test for each renderer:

- Missing source file returns the documented sentinel.
- Empty source file does not crash and returns a sentinel.
- Long content truncates with the trailing marker and stays within
  `MAX_RENDER_LEN`.
- Renderer-specific shape assertions per the task brief.
"""

from __future__ import annotations

import json
from pathlib import Path

from src.mission_control_renderers import (
    MAX_RENDER_LEN,
    render_agent_history,
    render_bridge_stats,
    render_knowledge_base_index,
    render_protocol_and_roles,
    render_shared_memory,
    render_skill_registry,
)
from src.warroom_format import make_handoff_block


# ---- Shared helpers -------------------------------------------------------


def _make_handoff(
    key: str, title: str, owner: str, status: str, *, files: str = "~/x"
) -> str:
    """Build a handoff block then rewrite Status to the requested value.

    `make_handoff_block` always emits `Status: PENDING`. Tests need other
    statuses to assert grouping/labeling, so we swap the literal line.
    """
    block = make_handoff_block(
        handoff_key=key,
        title=title,
        owner=owner,
        files_touched=files,
        next_action="proceed",
        context_path="/tmp/ctx.md",
    )
    return block.replace("Status: PENDING", f"Status: {status}")


# ---- render_agent_history ------------------------------------------------


def test_agent_history_missing_file(tmp_path: Path) -> None:
    assert render_agent_history(tmp_path / "missing.md") == "(no handoff history)"


def test_agent_history_empty_file(tmp_path: Path) -> None:
    p = tmp_path / "HANDOFFS.md"
    p.write_text("", encoding="utf-8")
    assert render_agent_history(p) == "(no handoff history)"


def test_agent_history_groups_by_owner_and_limits(tmp_path: Path) -> None:
    blocks = []
    # 6 Hermes tasks (oldest -> newest), 2 OpenClaw, 1 Codex, 1 User, 1 Unknown owner.
    for i in range(6):
        blocks.append(
            _make_handoff(
                f"wrb_aaaaaa00000{i:01x}",
                f"Hermes job {i}",
                "Hermes",
                "COMPLETED",
            )
        )
    blocks.append(_make_handoff("wrb_bbbbbbbbbbb1", "OC one", "OpenClaw", "IN PROGRESS"))
    blocks.append(_make_handoff("wrb_bbbbbbbbbbb2", "OC two", "OpenClaw", "FAILED"))
    blocks.append(_make_handoff("wrb_cccccccccccc", "Codex job", "Codex", "BLOCKED"))
    blocks.append(_make_handoff("wrb_dddddddddddd", "User reply", "User", "PENDING"))
    # "Robot" is not in the canonical owner list; should still appear, after the canonicals.
    blocks.append(_make_handoff("wrb_eeeeeeeeeeee", "Robot job", "Robot", "PENDING"))

    handoffs = tmp_path / "HANDOFFS.md"
    handoffs.write_text("\n".join(blocks), encoding="utf-8")

    out = render_agent_history(handoffs, limit_per_agent=3)

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


def test_agent_history_truncates(tmp_path: Path) -> None:
    # Generate enough handoffs that grouped output blows past the cap.
    blocks = [
        _make_handoff(
            f"wrb_{i:012x}",
            "x" * 180,  # long titles
            "Hermes",
            "COMPLETED",
        )
        for i in range(80)
    ]
    handoffs = tmp_path / "HANDOFFS.md"
    handoffs.write_text("\n".join(blocks), encoding="utf-8")

    out = render_agent_history(handoffs, limit_per_agent=80)
    assert len(out) <= MAX_RENDER_LEN
    assert out.endswith("...[truncated]")


# ---- render_shared_memory ------------------------------------------------


def test_shared_memory_missing(tmp_path: Path) -> None:
    assert render_shared_memory(tmp_path / "absent.md") == "(no shared memory yet)"


def test_shared_memory_empty(tmp_path: Path) -> None:
    p = tmp_path / "SHARED_MEMORY.md"
    p.write_text("   \n\n", encoding="utf-8")
    assert render_shared_memory(p) == "(no shared memory yet)"


def test_shared_memory_passthrough_and_truncate(tmp_path: Path) -> None:
    p = tmp_path / "SHARED_MEMORY.md"
    short = "# Shared\nhello world\n"
    p.write_text(short, encoding="utf-8")
    assert render_shared_memory(p) == short

    long_text = "x" * (MAX_RENDER_LEN * 3)
    p.write_text(long_text, encoding="utf-8")
    out = render_shared_memory(p)
    assert len(out) <= MAX_RENDER_LEN
    assert out.endswith("...[truncated]")


# ---- render_knowledge_base_index -----------------------------------------


def test_kb_index_missing_directory(tmp_path: Path) -> None:
    assert (
        render_knowledge_base_index(tmp_path / "no_such_dir")
        == "(no knowledge base files)"
    )


def test_kb_index_not_a_directory(tmp_path: Path) -> None:
    f = tmp_path / "file.md"
    f.write_text("hi", encoding="utf-8")
    assert render_knowledge_base_index(f) == "(no knowledge base files)"


def test_kb_index_empty_directory(tmp_path: Path) -> None:
    kb = tmp_path / "kb"
    kb.mkdir()
    assert render_knowledge_base_index(kb) == "(no knowledge base files)"


def test_kb_index_lists_md_files_sorted(tmp_path: Path) -> None:
    kb = tmp_path / "kb"
    (kb / "nested").mkdir(parents=True)
    (kb / "deep" / "deeper").mkdir(parents=True)

    # 3 .md files within two levels.
    (kb / "alpha.md").write_text("a" * 10, encoding="utf-8")
    (kb / "nested" / "bravo.md").write_text("bb" * 8, encoding="utf-8")  # 16
    (kb / "nested" / "charlie.md").write_text("c" * 5, encoding="utf-8")
    # Non-.md ignored.
    (kb / "ignore.txt").write_text("nope", encoding="utf-8")
    # Three-level-deep .md ignored.
    (kb / "deep" / "deeper" / "ignored.md").write_text("z" * 7, encoding="utf-8")

    out = render_knowledge_base_index(kb)
    lines = out.splitlines()
    assert lines == [
        "- alpha.md (10 bytes)",
        "- nested/bravo.md (16 bytes)",
        "- nested/charlie.md (5 bytes)",
    ]


def test_kb_index_truncates(tmp_path: Path) -> None:
    kb = tmp_path / "kb"
    kb.mkdir()
    # Each filename roughly 25 chars, line ~ "- xxxx...xx.md (N bytes)\n" ~ 40 chars.
    # 200 files easily exceed the 1900 cap.
    for i in range(200):
        (kb / f"file_{i:04d}_{'x' * 10}.md").write_text("data", encoding="utf-8")
    out = render_knowledge_base_index(kb)
    assert len(out) <= MAX_RENDER_LEN
    assert out.endswith("...[truncated]")


# ---- render_skill_registry -----------------------------------------------


def test_skill_registry_missing(tmp_path: Path) -> None:
    assert render_skill_registry(tmp_path / "absent.md") == "(no skill registry)"


def test_skill_registry_empty(tmp_path: Path) -> None:
    p = tmp_path / "SKILL_REGISTRY.md"
    p.write_text("", encoding="utf-8")
    assert render_skill_registry(p) == "(no skill registry)"


def test_skill_registry_passthrough_and_truncate(tmp_path: Path) -> None:
    p = tmp_path / "SKILL_REGISTRY.md"
    short = "## skills\n- one\n- two\n"
    p.write_text(short, encoding="utf-8")
    assert render_skill_registry(p) == short

    p.write_text("z" * (MAX_RENDER_LEN * 2), encoding="utf-8")
    out = render_skill_registry(p)
    assert len(out) <= MAX_RENDER_LEN
    assert out.endswith("...[truncated]")


# ---- render_protocol_and_roles -------------------------------------------


def test_protocol_and_roles_both_missing(tmp_path: Path) -> None:
    out = render_protocol_and_roles(
        tmp_path / "no_proto.md", tmp_path / "no_roles.md"
    )
    assert "## Protocol" in out
    assert "## Agent Roles" in out
    # Two `(missing)` markers, one per section.
    assert out.count("(missing)") == 2


def test_protocol_and_roles_only_protocol_missing(tmp_path: Path) -> None:
    roles = tmp_path / "AGENT_ROLES.md"
    roles.write_text("# Roles\nHermes is great.\n", encoding="utf-8")

    out = render_protocol_and_roles(tmp_path / "no_proto.md", roles)

    # Protocol section is missing, but the roles section is intact.
    protocol_section = out.split("## Protocol", 1)[1].split("## Agent Roles", 1)[0]
    assert "(missing)" in protocol_section
    roles_section = out.split("## Agent Roles", 1)[1]
    assert "Hermes is great." in roles_section
    assert "(missing)" not in roles_section


def test_protocol_and_roles_both_present(tmp_path: Path) -> None:
    proto = tmp_path / "PROTOCOL.md"
    proto.write_text("Protocol body here.", encoding="utf-8")
    roles = tmp_path / "AGENT_ROLES.md"
    roles.write_text("Roles body here.", encoding="utf-8")

    out = render_protocol_and_roles(proto, roles)
    assert "## Protocol\nProtocol body here." in out
    assert "## Agent Roles\nRoles body here." in out
    assert "(missing)" not in out


def test_protocol_and_roles_empty_files_do_not_crash(tmp_path: Path) -> None:
    proto = tmp_path / "PROTOCOL.md"
    proto.write_text("", encoding="utf-8")
    roles = tmp_path / "AGENT_ROLES.md"
    roles.write_text("", encoding="utf-8")
    out = render_protocol_and_roles(proto, roles)
    # Empty file is rendered the same as missing (both bodies blank/sentinel),
    # but the renderer must not crash and both section headers must appear.
    assert "## Protocol" in out
    assert "## Agent Roles" in out


def test_protocol_and_roles_truncates(tmp_path: Path) -> None:
    proto = tmp_path / "PROTOCOL.md"
    roles = tmp_path / "AGENT_ROLES.md"
    proto.write_text("a" * MAX_RENDER_LEN, encoding="utf-8")
    roles.write_text("b" * MAX_RENDER_LEN, encoding="utf-8")
    out = render_protocol_and_roles(proto, roles)
    assert len(out) <= MAX_RENDER_LEN
    assert out.endswith("...[truncated]")


# ---- render_bridge_stats -------------------------------------------------


def test_bridge_stats_missing(tmp_path: Path) -> None:
    assert (
        render_bridge_stats(tmp_path / "absent.json") == "(no bridge state yet)"
    )


def test_bridge_stats_empty(tmp_path: Path) -> None:
    p = tmp_path / "state.json"
    p.write_text("", encoding="utf-8")
    assert render_bridge_stats(p) == "(no bridge state yet)"


def test_bridge_stats_malformed(tmp_path: Path) -> None:
    p = tmp_path / "state.json"
    p.write_text("{not valid json", encoding="utf-8")
    assert render_bridge_stats(p) == "(bridge state unreadable)"


def test_bridge_stats_non_object(tmp_path: Path) -> None:
    p = tmp_path / "state.json"
    p.write_text("[1, 2, 3]", encoding="utf-8")
    assert render_bridge_stats(p) == "(bridge state unreadable)"


def test_bridge_stats_reports_counts(tmp_path: Path) -> None:
    state = {
        "version": 1,
        "command_center_data_source_id": "ds_123",
        "dashboard_block_id": "blk_999",
        "mission_control": {
            "agent_history": "blk_a",
            "agent_history_hash": "hashA",
            "shared_memory": "blk_b",
            "shared_memory_hash": "hashB",
            "knowledge_base": "blk_c",
            "knowledge_base_hash": "hashC",
        },
        "pages": {
            "p1": {"last_notion_status": "Dispatched"},
            "p2": {"last_notion_status": "Completed"},
            "p3": {"last_notion_status": "Completed"},
            "p4": {"last_notion_status": "Blocked"},
            "p5": {},  # missing status -> bucketed as (unknown)
        },
    }
    p = tmp_path / "state.json"
    p.write_text(json.dumps(state), encoding="utf-8")

    out = render_bridge_stats(p)

    assert "Tracked pages: 5" in out
    assert "Command Center data source: ds_123" in out
    assert "Dashboard block id: blk_999" in out
    assert "Mission Control sections tracked: 3" in out
    # Per-status counts present (sorted, so deterministic positions).
    assert "- Blocked: 1" in out
    assert "- Completed: 2" in out
    assert "- Dispatched: 1" in out
    assert "- (unknown): 1" in out


def test_bridge_stats_empty_state(tmp_path: Path) -> None:
    p = tmp_path / "state.json"
    p.write_text(json.dumps({}), encoding="utf-8")
    out = render_bridge_stats(p)
    assert "Tracked pages: 0" in out
    assert "Command Center data source: (none)" in out
    assert "Dashboard block id: (none)" in out
    assert "Mission Control sections tracked: 0" in out
    # No pages -> show a "(none)" line under the status section.
    assert "- (none)" in out


def test_bridge_stats_truncates(tmp_path: Path) -> None:
    # 500 pages with long status strings to bust the cap via the per-status
    # counts list.
    pages = {
        f"page_{i:04d}": {"last_notion_status": f"Status_{i:04d}_{'x' * 40}"}
        for i in range(500)
    }
    p = tmp_path / "state.json"
    p.write_text(json.dumps({"pages": pages}), encoding="utf-8")
    out = render_bridge_stats(p)
    assert len(out) <= MAX_RENDER_LEN
    assert out.endswith("...[truncated]")
