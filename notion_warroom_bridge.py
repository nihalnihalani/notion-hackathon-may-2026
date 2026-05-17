"""Notion <-> War Room bridge daemon.

Plan-aligned entry point. Loops every `POLL_SECONDS`:
  1. Resolve a Notion data source id (preferring `NOTION_COMMAND_CENTER_DATA_SOURCE_ID`,
     otherwise discovering one from `NOTION_COMMAND_CENTER_DATABASE_ID`).
  2. Run dispatch sync (Notion -> HANDOFFS.md).
  3. Run result sync (HANDOFFS.md -> Notion).
  4. Run dashboard sync (CURRENT_STATE.md -> single Notion code block).
  5. Log errors and continue. One bad task must not crash the daemon.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path
from typing import Optional

from src.config import build_client, load_config
from src.dashboard_sync import sync_dashboard
from src.dispatch_sync import sync_dispatch
from src.result_sync import sync_results
from src.state_store import StateStore

log = logging.getLogger("notion_warroom_bridge")


def _resolve_data_source_id(notion, config, store: StateStore) -> Optional[str]:
    """Pick or discover the Notion data source id used for Command Center polling."""
    if config.notion_command_center_data_source_id:
        ds = config.notion_command_center_data_source_id
        store.set_command_center_data_source_id(ds)
        return ds

    cached = store.load().get("command_center_data_source_id")
    if cached:
        return cached

    if config.notion_command_center_database_id:
        discovered = notion.discover_first_data_source(
            config.notion_command_center_database_id
        )
        if discovered:
            store.set_command_center_data_source_id(discovered)
            return discovered
    return None


def _one_cycle(notion, config, store: StateStore) -> None:
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
            log.info("dispatched %d task(s) to HANDOFFS.md", dispatched)

        pushed = sync_results(notion, config.warroom_path, store=store)
        if pushed:
            log.info("pushed %d result(s) back to Notion", pushed)

    if sync_dashboard(
        notion, config.notion_dashboard_page_id, config.warroom_path, store
    ):
        log.info("CURRENT_STATE.md upserted into Notion dashboard block")


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
    config = load_config(env_file=env_file if env_file.exists() else None)

    notion = build_client(config)
    store = StateStore(config.warroom_path)

    log.info("starting bridge; poll_seconds=%s warroom=%s",
             config.poll_seconds, config.warroom_path)

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
