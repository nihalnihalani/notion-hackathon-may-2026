"""Notion <-> War Room bridge daemon (Redis-backed).

Plan-aligned entry point. Loops every `POLL_SECONDS`:
  1. Resolve a Notion data source id (preferring `NOTION_COMMAND_CENTER_DATA_SOURCE_ID`,
     otherwise discovering one from `NOTION_COMMAND_CENTER_DATABASE_ID`).
  2. Run dispatch sync (Notion -> Redis-backed handoff store).
  3. Run result sync (Redis-backed handoffs -> Notion).
  4. Run dashboard sync (Redis `CURRENT_STATE.md` -> single Notion code block).
  5. Run Mission Control + OpenClaw screen syncs.
  6. Optionally run KB and Skill Inbox syncs when their parent pages are configured.
  7. Log errors and continue. One bad task must not crash the daemon.

Storage backend: every read/write the bridge does is mediated by
`src.redis_store.RedisStore`. War Room state lives in Redis (see plan
Path B). A separate `scripts/redis_file_mirror.py` process mirrors the
relevant keys onto `~/WarRoom/*.md` so the agent CLIs that still expect
local files keep working unchanged.

Connection: set `REDIS_URL` in `.env`. Typical values:
    rediss://default:<token>@<host>.upstash.io:6379  (Upstash TLS)
    redis://localhost:6379                            (local dev)
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

from src.config import build_client, load_config
from src.dispatch_sync import sync_dispatch
from src.knowledge_base_sync import sync_knowledge_base
from src.log_archive import attach_file_logger
from src.mission_control_sync import sync_mission_control
from src.openclaw_screens_sync import sync_openclaw_screens
from src.redis_store import RedisStore
from src.result_sync import sync_results
from src.skill_inbox_sync import sync_skill_inbox

log = logging.getLogger("notion_warroom_bridge")


def _resolve_data_source_id(
    notion, config, store: RedisStore
) -> Optional[str]:
    """Pick or discover the Notion data source id used for Command Center polling.

    The cache lives inside the bridge-state JSON blob (under
    `command_center_data_source_id`) so it survives across restarts.
    """
    if config.notion_command_center_data_source_id:
        ds = config.notion_command_center_data_source_id
        with store.locked():
            state = store.get_bridge_state()
            state["command_center_data_source_id"] = ds
            store.set_bridge_state(state)
        return ds

    cached = store.get_bridge_state().get("command_center_data_source_id")
    if isinstance(cached, str) and cached:
        return cached

    if config.notion_command_center_database_id:
        discovered = notion.discover_first_data_source(
            config.notion_command_center_database_id
        )
        if discovered:
            with store.locked():
                state = store.get_bridge_state()
                state["command_center_data_source_id"] = discovered
                store.set_bridge_state(state)
            return discovered
    return None


def _one_cycle(notion, config, store: RedisStore) -> None:
    data_source_id = _resolve_data_source_id(notion, config, store)
    if not data_source_id:
        log.warning(
            "no Notion data source id available; skipping dispatch/result sync"
        )
    else:
        dispatched = sync_dispatch(
            notion, data_source_id, config.warroom_path, store=store
        )
        if dispatched:
            log.info("dispatched %d task(s) to Redis handoff store", dispatched)

        pushed = sync_results(notion, store=store)
        if pushed:
            log.info("pushed %d result(s) back to Notion", pushed)

    sync_mission_control(notion, config.notion_dashboard_page_id, store)
    log.info("Mission control dashboard blocks synced")

    screens_pushed = sync_openclaw_screens(notion, store)
    if screens_pushed:
        log.info("refreshed %d OpenClaw screen(s)", screens_pushed)

    # Phase-two optional syncs: only fire when the corresponding parent
    # page id is configured. Missing config = the feature stays off.
    kb_parent = getattr(config, "notion_knowledge_base_db_id", None)
    if kb_parent:
        kb_synced = sync_knowledge_base(notion, kb_parent, store)
        if kb_synced:
            log.info("synced %d KnowledgeBase doc(s) to Notion", kb_synced)

    skills_parent = getattr(config, "notion_runbook_db_id", None)
    if skills_parent:
        skills_synced = sync_skill_inbox(notion, skills_parent, store)
        if skills_synced:
            log.info("synced %d Skill Inbox runbook(s) to Notion", skills_synced)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Notion <-> War Room Bridge Daemon"
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run one dispatch/result/dashboard cycle and exit",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        help="Logging verbosity (DEBUG, INFO, WARNING, ERROR)",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    base_dir = Path(__file__).parent.resolve()
    env_file = base_dir / ".env"
    # `load_config` reads .env into its own dataclass; also push the values
    # into os.environ so RedisStore (and any other process-env consumer)
    # picks up REDIS_URL transparently.
    if env_file.exists():
        load_dotenv(env_file)
    config = load_config(env_file=env_file if env_file.exists() else None)

    notion = build_client(config)
    store = RedisStore()  # REDIS_URL read from .env / process env

    log_path = attach_file_logger(
        config.warroom_path,
        level=getattr(logging, args.log_level.upper(), logging.INFO),
    )

    log.info(
        "starting bridge (Redis backend); poll_seconds=%s warroom=%s log=%s",
        config.poll_seconds, config.warroom_path, log_path,
    )

    try:
        while True:
            try:
                _one_cycle(notion, config, store)
            except Exception:
                log.exception("bridge sync cycle failed; continuing")
                if args.once:
                    return 1

            if args.once:
                return 0

            time.sleep(config.poll_seconds)
    except KeyboardInterrupt:
        log.info("interrupted; shutting down")
        return 0


if __name__ == "__main__":
    sys.exit(main())
