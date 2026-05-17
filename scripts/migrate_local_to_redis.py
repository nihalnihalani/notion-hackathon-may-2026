#!/usr/bin/env python3
"""One-time migration: copy `~/WarRoom/*` state into Redis.

Before the Redis cutover, the bridge accumulated state in two places:
  - `~/WarRoom/.notion_bridge_state.json` — Notion page mappings, block
    ids, Mission Control + OpenClaw page-tree state, etc.
  - `~/WarRoom/*.md` and subdirs — CURRENT_STATE, SHARED_MEMORY,
    AGENT_ROLES, PROTOCOL, SCHEDULE, PROJECTS, KnowledgeBase/**,
    Skill_Inbox/**, NotionInbox/*.md, HANDOFFS.md.

After cutover the bridge expects all of that in Redis under the
`wr:*` key prefix. This script copies it once and exits.

Re-running is safe: every write is an upsert, no destructive ops.

Usage:
    python scripts/migrate_local_to_redis.py            # actually migrate
    python scripts/migrate_local_to_redis.py --dry-run  # print plan only

The bridge daemon and the file mirror MUST be stopped while this runs.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from dotenv import load_dotenv  # noqa: E402

from src.redis_store import RedisStore  # noqa: E402
from src.warroom_format import parse_handoffs  # noqa: E402


log = logging.getLogger("migrate_local_to_redis")


# Top-level War Room files that map 1-to-1 onto `wr:file:<name>`.
TOP_LEVEL_FILES = (
    "CURRENT_STATE.md",
    "SHARED_MEMORY.md",
    "AGENT_ROLES.md",
    "PROTOCOL.md",
    "SCHEDULE.md",
    "PROJECTS.md",
    "REFERENCES.md",
    "SKILL_REGISTRY.md",
    "TASKS.md",
    "AGENTS.md",  # legacy, harmless if missing
)


def _migrate_bridge_state(store: RedisStore, warroom: Path, *, dry_run: bool) -> int:
    """Copy `.notion_bridge_state.json` to `wr:state:bridge`."""
    state_path = warroom / ".notion_bridge_state.json"
    if not state_path.exists():
        log.info("  (skip) no .notion_bridge_state.json — nothing to migrate")
        return 0
    try:
        raw = state_path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        log.error("  (fail) could not read state file: %s", exc)
        return 0
    if not isinstance(data, dict):
        log.error("  (fail) state file is not a JSON object")
        return 0

    keys = sorted(data.keys())
    inner = {
        "pages": len((data.get("pages") or {})),
        "mission_control": len((data.get("mission_control") or {})),
        "mission_control_pages": len((data.get("mission_control_pages") or {})),
        "openclaw_pages": len((data.get("openclaw_pages") or {})),
        "kb_pages": len((data.get("kb_pages") or {})),
        "skill_pages": len((data.get("skill_pages") or {})),
    }
    log.info(
        "  bridge state has %d top-level keys; counts %s",
        len(keys), inner,
    )
    if dry_run:
        return 1
    store.set_bridge_state(data)
    return 1


def _migrate_top_level_files(
    store: RedisStore, warroom: Path, *, dry_run: bool
) -> int:
    n = 0
    for name in TOP_LEVEL_FILES:
        path = warroom / name
        if not path.exists():
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except OSError as exc:
            log.warning("  (skip) %s: %s", name, exc)
            continue
        log.info("  file %s  (%d bytes)", name, len(content))
        if not dry_run:
            store.set_file(name, content)
        n += 1
    return n


def _migrate_kb(store: RedisStore, warroom: Path, *, dry_run: bool) -> int:
    kb_dir = warroom / "KnowledgeBase"
    if not kb_dir.is_dir():
        log.info("  (skip) no KnowledgeBase/ directory")
        return 0
    n = 0
    for path in sorted(kb_dir.rglob("*.md")):
        try:
            rel = path.relative_to(kb_dir).as_posix()
            content = path.read_text(encoding="utf-8")
        except (OSError, ValueError) as exc:
            log.warning("  (skip) %s: %s", path, exc)
            continue
        log.info("  kb   %s  (%d bytes)", rel, len(content))
        if not dry_run:
            store.set_kb_doc(rel, content)
        n += 1
    return n


def _migrate_skills(store: RedisStore, warroom: Path, *, dry_run: bool) -> int:
    skill_dir = warroom / "Skill_Inbox"
    if not skill_dir.is_dir():
        log.info("  (skip) no Skill_Inbox/ directory")
        return 0
    n = 0
    for path in sorted(skill_dir.rglob("*.md")):
        try:
            rel = path.relative_to(skill_dir).as_posix()
            content = path.read_text(encoding="utf-8")
        except (OSError, ValueError) as exc:
            log.warning("  (skip) %s: %s", path, exc)
            continue
        log.info("  skill %s  (%d bytes)", rel, len(content))
        if not dry_run:
            store.set_skill(rel, content)
        n += 1
    return n


def _migrate_notion_inbox(
    store: RedisStore, warroom: Path, *, dry_run: bool
) -> int:
    inbox = warroom / "NotionInbox"
    if not inbox.is_dir():
        log.info("  (skip) no NotionInbox/ directory")
        return 0
    n = 0
    for path in sorted(inbox.glob("*.md")):
        # Filename is the handoff key.
        key = path.stem
        try:
            body = path.read_text(encoding="utf-8")
        except OSError as exc:
            log.warning("  (skip) %s: %s", path, exc)
            continue
        log.info("  inbox %s  (%d bytes)", key, len(body))
        if not dry_run:
            store.set_notion_inbox(key, body)
        n += 1
    return n


_KEY_LINE = re.compile(r"\[(wrb_[0-9a-f]{12})\]")


def _migrate_handoffs(
    store: RedisStore, warroom: Path, *, dry_run: bool
) -> int:
    path = warroom / "HANDOFFS.md"
    if not path.exists():
        log.info("  (skip) no HANDOFFS.md")
        return 0
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        log.error("  (fail) HANDOFFS.md: %s", exc)
        return 0
    n = 0
    for key, fields in parse_handoffs(text):
        title = re.sub(r"\s*\[wrb_[0-9a-f]{12}\]\s*$", "", fields.get("Task", "")).strip()
        log.info("  handoff %s  Owner=%s Status=%s", key, fields.get("Owner"), fields.get("Status"))
        if not dry_run:
            store.upsert_handoff(
                key,
                task=title,
                owner=fields.get("Owner", ""),
                files_touched=fields.get("Files Touched", ""),
                status=fields.get("Status", "PENDING"),
                result=fields.get("Result", ""),
                next_action=fields.get("Next Action", ""),
                context="",
            )
        n += 1
    return n


def main() -> int:
    parser = argparse.ArgumentParser(
        description="One-time migration of ~/WarRoom state to Redis"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print what would be migrated, but don't write anything to Redis",
    )
    parser.add_argument(
        "--log-level", default="INFO",
        help="DEBUG / INFO / WARNING / ERROR",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(levelname)s %(message)s",
    )

    # Load REDIS_URL + WARROOM_PATH from .env.
    load_dotenv(REPO_ROOT / ".env")
    warroom = Path(os.environ.get("WARROOM_PATH", "~/WarRoom")).expanduser().resolve()
    if not warroom.is_dir():
        log.error("WARROOM_PATH does not exist: %s", warroom)
        return 1
    log.info("warroom: %s", warroom)
    log.info("mode:    %s", "DRY-RUN" if args.dry_run else "WRITE")

    try:
        store = RedisStore()
    except Exception as exc:
        log.error("could not connect to Redis: %s", exc)
        log.error("set REDIS_URL in .env first (e.g. rediss://default:<token>@host:6379)")
        return 1

    log.info("")
    log.info("[1/6] bridge state")
    n_state = _migrate_bridge_state(store, warroom, dry_run=args.dry_run)
    log.info("[2/6] top-level files")
    n_files = _migrate_top_level_files(store, warroom, dry_run=args.dry_run)
    log.info("[3/6] KnowledgeBase docs")
    n_kb = _migrate_kb(store, warroom, dry_run=args.dry_run)
    log.info("[4/6] Skill Inbox")
    n_sk = _migrate_skills(store, warroom, dry_run=args.dry_run)
    log.info("[5/6] NotionInbox context snapshots")
    n_in = _migrate_notion_inbox(store, warroom, dry_run=args.dry_run)
    log.info("[6/6] HANDOFFS.md → handoff hashes")
    n_ho = _migrate_handoffs(store, warroom, dry_run=args.dry_run)

    log.info("")
    log.info("Summary:")
    log.info("  bridge state         : %d", n_state)
    log.info("  top-level files      : %d", n_files)
    log.info("  KnowledgeBase docs   : %d", n_kb)
    log.info("  Skill Inbox docs     : %d", n_sk)
    log.info("  NotionInbox snapshots: %d", n_in)
    log.info("  Handoffs             : %d", n_ho)
    if args.dry_run:
        log.info("Dry run — nothing written. Re-run without --dry-run to commit.")
    else:
        log.info("Migration complete. Bridge daemon can start now.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
