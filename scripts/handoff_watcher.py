#!/usr/bin/env python3
"""Handoff watcher: dispatches PENDING HANDOFFS.md entries to agent CLIs.

This script lives OUTSIDE `src/` deliberately. The bridge's no-unsafe-
imports test (tests/test_no_unsafe_imports.py) scans `src/**/*.py` and
`notion_warroom_bridge.py` for banned tokens (subprocess, os.system,
pty, telegram, slack_sdk, paramiko, hermes chat, openclaw agent).
By keeping shell execution in this separate process, the bridge stays
plan-§2 clean:

    notion_warroom_bridge.py     ← courier (no CLI invocation)
    scripts/handoff_watcher.py   ← this script (the one allowed shell)

The watcher is the ONLY place in the project where subprocess is used.
If a future PR moves CLI invocation back into the bridge, the guardrail
test fails — that is intentional.

## Safety defaults

- Default mode is **dry-run** — the script prints what it WOULD invoke
  but never actually runs anything. You must explicitly pass `--execute`
  to actually run agent CLIs.
- Owners are whitelisted (Hermes, OpenClaw, Codex, Claude). Anything
  else is skipped with a warning.
- Subprocess is always called with shell=False and an argv list; the
  task title goes through as an argv string, not interpreted by a
  shell. Newlines/quotes/backticks in Notion-derived text cannot
  become shell metacharacters.
- Each dispatch is time-boxed via subprocess.run(timeout=...).
- stdout+stderr stream to a per-handoff log under
  ~/WarRoom/.handoff_watcher_logs/<key>.log so you can audit.
- A sidecar state file ~/WarRoom/.handoff_watcher_state.json tracks
  which handoff keys we've already executed so re-runs are idempotent.

## Flow

    1. Acquire the shared bridge lock (~/WarRoom/.notion_bridge.lock).
    2. Parse HANDOFFS.md via `src.warroom_format.parse_handoffs`.
    3. For each PENDING entry whose key we haven't executed yet:
       a. Pick the CLI handler for the Owner.
       b. Update HANDOFFS.md → Status: IN PROGRESS (atomic).
       c. Release lock.
       d. subprocess.run(cmd, timeout=...).
       e. Re-acquire lock; update Status: COMPLETED (rc=0) or FAILED.
       f. Persist state. Dry-run mode never writes dispatch state.
    4. The bridge daemon's next tick picks up the new status and
       syncs it back to the Notion card.

## CLI

    --once             process pending entries once, exit
    --interval N       polling interval in seconds (default 10)
    --execute          actually invoke CLIs (default: dry-run)
    --owners O1,O2     restrict to a subset of owners
    --log-level LVL    DEBUG / INFO / WARNING / ERROR
"""

# This file deliberately uses subprocess. See module docstring. The
# guardrail test does not scan scripts/.
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import subprocess  # noqa: S404 — see module docstring
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Optional

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from filelock import FileLock  # noqa: E402

from src.warroom_format import parse_handoffs  # noqa: E402


WARROOM_PATH = Path(os.environ.get("WARROOM_PATH", "~/WarRoom")).expanduser().resolve()
OPENCLAW_AGENT_ID = os.environ.get("OPENCLAW_AGENT_ID", "main")
HANDOFFS_FILE = WARROOM_PATH / "HANDOFFS.md"
LOCK_FILE = WARROOM_PATH / ".notion_bridge.lock"
STATE_FILE = WARROOM_PATH / ".handoff_watcher_state.json"
LOG_DIR = WARROOM_PATH / ".handoff_watcher_logs"
NOTION_INBOX = WARROOM_PATH / "NotionInbox"

DEFAULT_TIMEOUT = 600  # 10 minutes per invocation
DEFAULT_INTERVAL = 10.0

log = logging.getLogger("handoff_watcher")


# ---- CLI invocation map ---------------------------------------------------
# Each handler takes (title, context_path, raw_fields) and returns a
# list[str] suitable for subprocess.run(cmd, shell=False).
#
# These are reasonable defaults. EDIT them to match the exact CLI
# signatures installed on your machine; the script is intended to be
# tweaked, not pinned. The `Claude` handler uses the pattern from your
# ~/.claude/CLAUDE.md Alhinai/Hermes execution posture.

CliHandler = Callable[[str, Path, dict], list[str]]


def _hermes_handler(title: str, context_path: Path, fields: dict) -> list[str]:
    prompt = _agent_prompt(title, context_path, fields)
    return ["hermes", "chat", "-Q", "-q", prompt, "--max-turns", "100", "--yolo"]


def _openclaw_handler(title: str, context_path: Path, fields: dict) -> list[str]:
    prompt = _agent_prompt(title, context_path, fields)
    return [
        "openclaw",
        "agent",
        "--agent",
        OPENCLAW_AGENT_ID,
        "--message",
        prompt,
        "--thinking",
        "high",
        "--timeout",
        str(DEFAULT_TIMEOUT),
        "--json",
    ]


def _codex_handler(title: str, context_path: Path, fields: dict) -> list[str]:
    prompt = _agent_prompt(title, context_path, fields)
    return [
        "codex",
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        prompt,
    ]


def _claude_handler(title: str, context_path: Path, fields: dict) -> list[str]:
    prompt = _agent_prompt(title, context_path, fields)
    return [
        "claude",
        "--dangerously-skip-permissions",
        "--permission-mode",
        "bypassPermissions",
        "-p",
        prompt,
    ]


def _agent_prompt(title: str, context_path: Path, fields: dict) -> str:
    return (
        f"Read the handoff context at {context_path} and act on the task. "
        f"Task title: {title}. Files Touched: {fields.get('Files Touched', '')}. "
        "Update HANDOFFS.md with Status COMPLETED or FAILED when done."
    )


AGENT_CLIS: dict[str, CliHandler] = {
    "Hermes": _hermes_handler,
    "OpenClaw": _openclaw_handler,
    "Codex": _codex_handler,
    "Claude": _claude_handler,
}


# ---- HANDOFFS.md status mutation -----------------------------------------

# The exact handoff block lives between two boundaries:
#   - the Task line that contains [wrb_xxx]
#   - the next blank line (or EOF)
# Inside that block we replace the Status: VALUE line and optionally
# append a one-liner to the Result: line.

_BLOCK_RE = re.compile(
    r"(- Task:[^\n]*\[(?P<key>wrb_[0-9a-f]{12})\][^\n]*\n"
    r"(?:  [^\n]*\n)+?)"
)


def _update_handoff_status(
    key: str, new_status: str, result_suffix: Optional[str] = None
) -> bool:
    """Re-write HANDOFFS.md in place, updating Status/Result for `key`.

    Returns True if the block was found and updated, False otherwise.
    Atomic write via temp file + os.replace.
    """
    if not HANDOFFS_FILE.exists():
        return False
    text = HANDOFFS_FILE.read_text(encoding="utf-8")

    # Find the block whose Task line carries [key].
    block_match = re.search(
        r"(- Task:[^\n]*\[" + re.escape(key) + r"\][^\n]*\n)"
        r"((?:  [^\n]*(?:\n|$))+)",
        text,
    )
    if not block_match:
        return False
    block_start, block_body = block_match.group(1), block_match.group(2)
    block_full = block_start + block_body

    # Rewrite Status line inside the body.
    new_body = re.sub(
        r"^  Status: .*$",
        f"  Status: {new_status}",
        block_body,
        count=1,
        flags=re.MULTILINE,
    )

    # Optionally append the result suffix to the Result line.
    if result_suffix:
        def append_result_suffix(match: re.Match) -> str:
            existing = match.group(1).rstrip()
            if result_suffix in existing:
                return "  Result:" + existing
            return (
                "  Result:"
                + (existing if existing.strip() else "")
                + (" " if existing.strip() else " ")
                + result_suffix
            )

        new_body = re.sub(
            r"^  Result:(.*)$",
            append_result_suffix,
            new_body,
            count=1,
            flags=re.MULTILINE,
        )

    new_text = text.replace(block_full, block_start + new_body, 1)
    if new_text == text:
        return False

    tmp = HANDOFFS_FILE.with_suffix(HANDOFFS_FILE.suffix + ".tmp")
    tmp.write_text(new_text, encoding="utf-8")
    os.replace(tmp, HANDOFFS_FILE)
    return True


# ---- Watcher state -------------------------------------------------------


def _load_state() -> dict:
    if not STATE_FILE.exists():
        return {"handoffs": {}}
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"handoffs": {}}
        data.setdefault("handoffs", {})
        return data
    except (json.JSONDecodeError, OSError):
        return {"handoffs": {}}


def _save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(STATE_FILE.suffix + ".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, STATE_FILE)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---- Dispatch one handoff ------------------------------------------------


def _title_from_task_field(task_field: str) -> str:
    """Strip the trailing `[wrb_xxx]` token from the Task field for display."""
    return re.sub(r"\s*\[wrb_[0-9a-f]{12}\]\s*$", "", task_field).strip() or "(untitled)"


def _dispatch_one(
    key: str,
    fields: dict,
    lock: FileLock,
    *,
    execute: bool,
    timeout: int,
) -> str:
    owner = (fields.get("Owner") or "").strip()
    handler = AGENT_CLIS.get(owner)
    if handler is None:
        log.warning("no CLI mapping for Owner=%r (handoff %s); skipping", owner, key)
        return "no_handler"

    context_path = NOTION_INBOX / f"{key}.md"
    title = _title_from_task_field(fields.get("Task") or "")
    cmd = handler(title, context_path, fields)

    if not execute:
        log.info(
            "[DRY-RUN] %s (Owner=%s) would run: %s",
            key, owner, " ".join(repr(c) for c in cmd),
        )
        return "dry_run"

    if not _binary_exists(cmd[0]):
        log.warning("CLI binary not found on PATH: %s (handoff %s)", cmd[0], key)
        with lock:
            _update_handoff_status(key, "FAILED", f"CLI not installed: {cmd[0]}")
        return "missing_binary"

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / f"{key}.log"

    with lock:
        _update_handoff_status(key, "IN PROGRESS")

    log.info("dispatching %s → %s (Owner=%s)", key, cmd[0], owner)
    started = _now_iso()
    rc = None
    error_note: Optional[str] = None

    try:
        with open(log_path, "w", encoding="utf-8") as logf:
            logf.write(f"# handoff {key} started {started}\n")
            logf.write(f"# command: {cmd}\n\n")
            logf.flush()
            completed = subprocess.run(  # noqa: S603 — argv list, shell=False, whitelisted CLI
                cmd,
                stdout=logf,
                stderr=subprocess.STDOUT,
                timeout=timeout,
                check=False,
                cwd=str(WARROOM_PATH),
            )
        rc = completed.returncode
    except subprocess.TimeoutExpired:
        error_note = f"timeout after {timeout}s"
    except FileNotFoundError:
        error_note = f"binary disappeared: {cmd[0]}"
    except Exception as exc:  # last-ditch; the watcher must not die.
        error_note = f"unexpected error: {type(exc).__name__}: {exc}"

    finished = _now_iso()
    if error_note:
        final_status = "FAILED"
        result_line = f"{error_note} (see {log_path.name})"
    elif rc == 0:
        final_status = "COMPLETED"
        result_line = f"exit=0 (see {log_path.name})"
    else:
        final_status = "FAILED"
        result_line = f"exit={rc} (see {log_path.name})"

    with lock:
        _update_handoff_status(key, final_status, result_line)

    log.info(
        "finished %s → %s (rc=%s, started=%s, finished=%s)",
        key, final_status, rc, started, finished,
    )
    return final_status.lower()


def _binary_exists(name: str) -> bool:
    import shutil
    return shutil.which(name) is not None


# ---- Main cycle ----------------------------------------------------------


def _read_handoffs_under_lock(lock: FileLock) -> str:
    with lock:
        if not HANDOFFS_FILE.exists():
            return ""
        return HANDOFFS_FILE.read_text(encoding="utf-8")


def _cycle(
    lock: FileLock,
    *,
    execute: bool,
    owners: Optional[set[str]],
    timeout: int,
) -> int:
    """Run one watcher pass; return the number of handoffs acted on."""
    state = _load_state()
    seen = state.get("handoffs", {})

    text = _read_handoffs_under_lock(lock)
    if not text:
        return 0

    actions = 0
    for key, fields in parse_handoffs(text):
        status = (fields.get("Status") or "").strip().upper()
        if status != "PENDING":
            continue
        previous = seen.get(key)
        if previous and (not execute or previous.get("outcome") != "dry_run"):
            continue
        owner = (fields.get("Owner") or "").strip()
        if owners is not None and owner not in owners:
            continue

        outcome = _dispatch_one(key, fields, lock, execute=execute, timeout=timeout)

        if execute:
            entry = {
                "outcome": outcome,
                "owner": owner,
                "started_at": _now_iso(),
            }
            state.setdefault("handoffs", {})[key] = entry
            _save_state(state)
        actions += 1

    return actions


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Handoff watcher: invokes agent CLIs for PENDING entries in "
        "HANDOFFS.md. Default is dry-run; pass --execute to actually invoke.",
    )
    parser.add_argument(
        "--once", action="store_true",
        help="Process current PENDING entries once and exit",
    )
    parser.add_argument(
        "--interval", type=float, default=DEFAULT_INTERVAL,
        help=f"Polling interval in seconds (default {DEFAULT_INTERVAL})",
    )
    parser.add_argument(
        "--execute", action="store_true",
        help="Actually invoke agent CLIs. Without this flag, the watcher is "
             "in dry-run mode and only prints what it would invoke.",
    )
    parser.add_argument(
        "--owners",
        type=lambda s: set(o.strip() for o in s.split(",") if o.strip()) if s else None,
        default=None,
        help="Comma-separated Owner whitelist (e.g. 'Hermes,Claude'). "
             "Default: all configured (Hermes, OpenClaw, Codex, Claude).",
    )
    parser.add_argument(
        "--timeout", type=int, default=DEFAULT_TIMEOUT,
        help=f"Per-invocation timeout in seconds (default {DEFAULT_TIMEOUT})",
    )
    parser.add_argument(
        "--log-level", default="INFO",
        help="DEBUG / INFO / WARNING / ERROR",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    mode = "EXECUTE" if args.execute else "DRY-RUN"
    log.info("handoff watcher starting (%s)  warroom=%s  handoffs=%s",
             mode, WARROOM_PATH, HANDOFFS_FILE)
    log.info("wired owners: %s", ", ".join(sorted(AGENT_CLIS.keys())))
    if args.owners is not None:
        log.info("owner whitelist active: %s", ", ".join(sorted(args.owners)))

    WARROOM_PATH.mkdir(parents=True, exist_ok=True)
    lock = FileLock(str(LOCK_FILE))

    if args.once:
        n = _cycle(lock, execute=args.execute, owners=args.owners, timeout=args.timeout)
        log.info("processed %d handoff(s)", n)
        return 0

    try:
        while True:
            try:
                n = _cycle(
                    lock, execute=args.execute, owners=args.owners, timeout=args.timeout
                )
                if n:
                    log.info("processed %d handoff(s)", n)
            except Exception:
                log.exception("watcher cycle failed; continuing")
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log.info("interrupted; shutting down")
        return 0


if __name__ == "__main__":
    sys.exit(main())
