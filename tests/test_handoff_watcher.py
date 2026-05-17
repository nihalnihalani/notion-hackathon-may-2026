"""Tests for scripts/handoff_watcher.py.

These tests exercise:
- The HANDOFFS.md status mutation (`_update_handoff_status`) — no
  subprocess, just text I/O.
- The CLI handler builders — verify shape, no execution.
- The cycle function in dry-run mode — confirms no subprocess is
  invoked even when wired CLIs exist.

We deliberately do NOT test `subprocess.run` invocation here; this is
the one file in the project allowed to call it, and live testing is
better done via `python scripts/handoff_watcher.py --once --dry-run`.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
WATCHER_PATH = REPO_ROOT / "scripts" / "handoff_watcher.py"
ORCHESTRATOR_PATH = REPO_ROOT / "scripts" / "warroom_orchestrator.py"


def _load_watcher(monkeypatch, warroom: Path):
    """Import handoff_watcher with WARROOM_PATH pointed at a tmp dir."""
    monkeypatch.setenv("WARROOM_PATH", str(warroom))
    monkeypatch.setenv("HANDOFF_WATCHER_DISABLE_REDIS", "1")
    # The module reads WARROOM_PATH at import time. Force a fresh import.
    for name in list(sys.modules):
        if name == "handoff_watcher":
            del sys.modules[name]
    spec = importlib.util.spec_from_file_location("handoff_watcher", WATCHER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_legacy_orchestrator_delegates_to_handoff_watcher():
    text = ORCHESTRATOR_PATH.read_text(encoding="utf-8")
    assert "from handoff_watcher import main" in text
    assert "subprocess" not in text
    assert "threading" not in text


# ---- CLI handlers --------------------------------------------------------


def test_hermes_handler_emits_argv_list(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    cmd = mod._hermes_handler(
        "inspect health",
        tmp_path / "ctx.md",
        {"Next Action": "Check the live bridge status."},
    )
    assert cmd[0] == "hermes"
    assert cmd[1] == "chat"
    assert "-Q" in cmd
    assert "-q" in cmd
    prompt = cmd[cmd.index("-q") + 1]
    assert "inspect health" in prompt
    assert str(tmp_path / "ctx.md") in prompt
    assert "Check the live bridge status." in prompt
    assert "Do not edit HANDOFFS.md" in prompt


def test_openclaw_handler_emits_argv_list(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    cmd = mod._openclaw_handler("plan demo", tmp_path / "ctx.md", {})
    assert cmd[0] == "openclaw"
    assert cmd[1] == "agent"
    assert "--agent" in cmd
    assert cmd[cmd.index("--agent") + 1] == "main"
    assert "--message" in cmd
    prompt = cmd[cmd.index("--message") + 1]
    assert "plan demo" in prompt
    assert str(tmp_path / "ctx.md") in prompt


def test_codex_handler_emits_argv_list(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    cmd = mod._codex_handler("write fn", tmp_path / "ctx.md", {})
    assert cmd[0] == "codex"
    assert cmd[1] == "exec"
    assert "--dangerously-bypass-approvals-and-sandbox" in cmd
    prompt_idx = cmd.index("--dangerously-bypass-approvals-and-sandbox") + 1
    assert "write fn" in cmd[prompt_idx]
    assert str(tmp_path / "ctx.md") in cmd[prompt_idx]


def test_claude_handler_uses_alhinai_posture(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    cmd = mod._claude_handler(
        "audit security", tmp_path / "ctx.md", {"Files Touched": "/srv/**"}
    )
    assert cmd[0] == "claude"
    assert "--dangerously-skip-permissions" in cmd
    assert "--permission-mode" in cmd
    assert "bypassPermissions" in cmd
    # Prompt mentions both the context path and the title.
    prompt_idx = cmd.index("-p") + 1
    assert "audit security" in cmd[prompt_idx]
    assert str(tmp_path / "ctx.md") in cmd[prompt_idx]
    assert "--max-turns" not in cmd


def test_unknown_owner_has_no_handler(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    assert "Hermes" in mod.AGENT_CLIS
    assert "OpenClaw" in mod.AGENT_CLIS
    assert "Codex" in mod.AGENT_CLIS
    assert "Claude" in mod.AGENT_CLIS
    assert "User" not in mod.AGENT_CLIS  # User tasks aren't executed by CLIs.


# ---- _title_from_task_field ----------------------------------------------


def test_title_from_task_field_strips_bridge_key(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    assert (
        mod._title_from_task_field("inspect War Room health [wrb_abcd12345678]")
        == "inspect War Room health"
    )


def test_title_from_task_field_empty_returns_untitled(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    assert mod._title_from_task_field("") == "(untitled)"


# ---- _update_handoff_status ----------------------------------------------


HANDOFF_TEXT = """
- Task: inspect War Room health [wrb_aaaaaaaaaaaa]
  Owner: Hermes
  Files Touched: /home/alhinai/WarRoom/**
  Status: PENDING
  Result:
  Next Action: Review the inbox.

- Task: ship demo [wrb_bbbbbbbbbbbb]
  Owner: OpenClaw
  Files Touched: /srv/**
  Status: PENDING
  Result:
  Next Action: Build the dashboard.
"""


def test_update_handoff_status_updates_in_place(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    mod.HANDOFFS_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.HANDOFFS_FILE.write_text(HANDOFF_TEXT, encoding="utf-8")

    assert mod._update_handoff_status("wrb_aaaaaaaaaaaa", "IN PROGRESS") is True

    new_text = mod.HANDOFFS_FILE.read_text(encoding="utf-8")
    # The Hermes block flipped...
    assert (
        "- Task: inspect War Room health [wrb_aaaaaaaaaaaa]\n"
        "  Owner: Hermes\n"
        "  Files Touched: /home/alhinai/WarRoom/**\n"
        "  Status: IN PROGRESS\n"
    ) in new_text
    # ...the OpenClaw block did NOT.
    assert (
        "- Task: ship demo [wrb_bbbbbbbbbbbb]\n"
        "  Owner: OpenClaw\n"
        "  Files Touched: /srv/**\n"
        "  Status: PENDING\n"
    ) in new_text


def test_update_handoff_status_appends_result_suffix(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    mod.HANDOFFS_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.HANDOFFS_FILE.write_text(HANDOFF_TEXT, encoding="utf-8")

    mod._update_handoff_status(
        "wrb_aaaaaaaaaaaa", "COMPLETED", "exit=0 (see wrb_aaaaaaaaaaaa.log)"
    )

    text = mod.HANDOFFS_FILE.read_text(encoding="utf-8")
    assert "Status: COMPLETED" in text
    assert "Result: exit=0 (see wrb_aaaaaaaaaaaa.log)" in text


def test_update_handoff_status_does_not_duplicate_result_suffix(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    mod.HANDOFFS_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.HANDOFFS_FILE.write_text(
        HANDOFF_TEXT.replace(
            "  Result:",
            "  Result: agent already wrote exit=0 (see wrb_aaaaaaaaaaaa.log)",
            1,
        ),
        encoding="utf-8",
    )

    mod._update_handoff_status(
        "wrb_aaaaaaaaaaaa", "COMPLETED", "exit=0 (see wrb_aaaaaaaaaaaa.log)"
    )

    text = mod.HANDOFFS_FILE.read_text(encoding="utf-8")
    assert text.count("exit=0 (see wrb_aaaaaaaaaaaa.log)") == 1


def test_update_handoff_status_returns_false_for_missing_key(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    mod.HANDOFFS_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.HANDOFFS_FILE.write_text(HANDOFF_TEXT, encoding="utf-8")
    assert mod._update_handoff_status("wrb_doesnotexist", "COMPLETED") is False
    # File untouched.
    assert mod.HANDOFFS_FILE.read_text(encoding="utf-8") == HANDOFF_TEXT


def test_update_handoff_status_atomic_write_leaves_no_temp_file(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    mod.HANDOFFS_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.HANDOFFS_FILE.write_text(HANDOFF_TEXT, encoding="utf-8")
    mod._update_handoff_status("wrb_aaaaaaaaaaaa", "IN PROGRESS")
    leftovers = [p for p in tmp_path.iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []


# ---- _cycle in dry-run mode ---------------------------------------------


def test_cycle_dry_run_does_not_invoke_subprocess(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    mod.HANDOFFS_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.HANDOFFS_FILE.write_text(HANDOFF_TEXT, encoding="utf-8")

    # Sanity check: if subprocess.run is called, this test must fail loudly.
    monkeypatch.setattr(
        mod.subprocess,
        "run",
        MagicMock(
            side_effect=AssertionError(
                "subprocess.run must NOT be called in dry-run mode"
            )
        ),
    )

    lock = mod.FileLock(str(mod.LOCK_FILE))
    actions = mod._cycle(
        lock, execute=False, owners=None, timeout=10
    )

    assert actions == 2  # both PENDING handoffs counted
    assert not mod.STATE_FILE.exists()


def test_cycle_skips_keys_already_in_state(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    mod.HANDOFFS_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.HANDOFFS_FILE.write_text(HANDOFF_TEXT, encoding="utf-8")
    # Pre-seed state — both keys already dispatched once.
    mod._save_state(
        {
            "handoffs": {
                "wrb_aaaaaaaaaaaa": {"outcome": "completed", "owner": "Hermes"},
                "wrb_bbbbbbbbbbbb": {"outcome": "dry_run", "owner": "OpenClaw"},
            }
        }
    )

    lock = mod.FileLock(str(mod.LOCK_FILE))
    actions = mod._cycle(lock, execute=False, owners=None, timeout=10)
    assert actions == 0


def test_cycle_does_not_let_old_dry_run_state_block_execute(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    mod.HANDOFFS_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.HANDOFFS_FILE.write_text(HANDOFF_TEXT, encoding="utf-8")
    mod._save_state(
        {
            "handoffs": {
                "wrb_aaaaaaaaaaaa": {"outcome": "dry_run", "owner": "Hermes"},
                "wrb_bbbbbbbbbbbb": {"outcome": "completed", "owner": "OpenClaw"},
            }
        }
    )
    monkeypatch.setattr(mod, "_binary_exists", lambda name: False)

    lock = mod.FileLock(str(mod.LOCK_FILE))
    actions = mod._cycle(lock, execute=True, owners=None, timeout=10)

    assert actions == 1
    state = json.loads(mod.STATE_FILE.read_text(encoding="utf-8"))
    assert state["handoffs"]["wrb_aaaaaaaaaaaa"]["outcome"] == "missing_binary"
    assert state["handoffs"]["wrb_bbbbbbbbbbbb"]["outcome"] == "completed"


def test_execute_uses_daemon_safe_subprocess_options(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    mod.HANDOFFS_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.HANDOFFS_FILE.write_text(
        "- Task: hermes task [wrb_aaaaaaaaaaaa]\n"
        "  Owner: Hermes\n"
        "  Files Touched: x\n"
        "  Status: PENDING\n"
        "  Result:\n"
        "  Next Action: None\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(mod, "_binary_exists", lambda name: True)
    run = MagicMock(return_value=mod.subprocess.CompletedProcess(["hermes"], 0))
    monkeypatch.setattr(mod.subprocess, "run", run)

    lock = mod.FileLock(str(mod.LOCK_FILE))
    actions = mod._cycle(lock, execute=True, owners=None, timeout=10)

    assert actions == 1
    kwargs = run.call_args.kwargs
    assert kwargs["stdin"] is mod.subprocess.DEVNULL
    assert kwargs["start_new_session"] is True
    state = json.loads(mod.STATE_FILE.read_text(encoding="utf-8"))
    assert state["handoffs"]["wrb_aaaaaaaaaaaa"]["outcome"] == "completed"


def test_running_handoff_state_is_recovered_after_timeout(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    mod.HANDOFFS_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.HANDOFFS_FILE.write_text(
        "- Task: stuck task [wrb_aaaaaaaaaaaa]\n"
        "  Owner: Hermes\n"
        "  Files Touched: x\n"
        "  Status: IN PROGRESS\n"
        "  Result:\n"
        "  Next Action: None\n",
        encoding="utf-8",
    )
    mod._save_state(
        {
            "handoffs": {
                "wrb_aaaaaaaaaaaa": {
                    "outcome": "running",
                    "owner": "Hermes",
                    "started_at": "2000-01-01T00:00:00Z",
                }
            }
        }
    )

    lock = mod.FileLock(str(mod.LOCK_FILE))
    actions = mod._cycle(lock, execute=True, owners=None, timeout=10)

    assert actions == 1
    text = mod.HANDOFFS_FILE.read_text(encoding="utf-8")
    assert "Status: FAILED" in text
    assert "watcher recovered stale IN PROGRESS after 10s" in text
    state = json.loads(mod.STATE_FILE.read_text(encoding="utf-8"))
    assert state["handoffs"]["wrb_aaaaaaaaaaaa"]["outcome"] == "timeout_recovered"


def test_cycle_respects_owners_whitelist(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    mod.HANDOFFS_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.HANDOFFS_FILE.write_text(HANDOFF_TEXT, encoding="utf-8")

    lock = mod.FileLock(str(mod.LOCK_FILE))
    actions = mod._cycle(
        lock, execute=False, owners={"Hermes"}, timeout=10
    )
    assert actions == 1
    assert not mod.STATE_FILE.exists()


def test_cycle_ignores_non_pending_handoffs(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    mod.HANDOFFS_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.HANDOFFS_FILE.write_text(
        "- Task: done [wrb_dddddddddddd]\n"
        "  Owner: Hermes\n"
        "  Files Touched: x\n"
        "  Status: COMPLETED\n"
        "  Result: shipped\n"
        "  Next Action: None\n",
        encoding="utf-8",
    )

    lock = mod.FileLock(str(mod.LOCK_FILE))
    actions = mod._cycle(lock, execute=False, owners=None, timeout=10)
    assert actions == 0


def test_cycle_skips_owners_without_handler(monkeypatch, tmp_path):
    mod = _load_watcher(monkeypatch, tmp_path)
    mod.HANDOFFS_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.HANDOFFS_FILE.write_text(
        "- Task: human task [wrb_eeeeeeeeeeee]\n"
        "  Owner: User\n"
        "  Files Touched: x\n"
        "  Status: PENDING\n"
        "  Result:\n"
        "  Next Action: None\n",
        encoding="utf-8",
    )

    lock = mod.FileLock(str(mod.LOCK_FILE))
    actions = mod._cycle(lock, execute=False, owners=None, timeout=10)
    assert actions == 1
    assert not mod.STATE_FILE.exists()
