import os
import sys
import time
import argparse
from pathlib import Path

from src.config import load_config, build_client
from src.dispatch_sync import sync_dispatch
from src.result_sync import sync_results
from src.state_observer import push_state_to_notion

def main():
    print("🚀 Starting Notion <-> War Room Bridge Daemon (V6 Final MVP)...")
    base_dir = Path(__file__).parent.resolve()
    config = load_config(env_file=base_dir / ".env")
    
    # Use the safe wrapper to hit the 2025-09-03 API directly
    notion = build_client(config) 

    warroom = str(config.warroom_path)
    dispatch_db = config.notion_command_center_database_id or config.notion_command_center_data_source_id
    state_block = config.notion_dashboard_page_id if getattr(config, 'notion_state_block_id', None) is None else getattr(config, 'notion_state_block_id', config.notion_dashboard_page_id)
    # The config file expects notion_dashboard_page_id, I'll check my env block
    if os.getenv("NOTION_STATE_BLOCK_ID"):
        state_block = os.getenv("NOTION_STATE_BLOCK_ID")
    
    poll_seconds = config.poll_seconds

    os.makedirs(warroom, exist_ok=True)

    try:
        while True:
            try:
                # 1. Dispatch (Notion -> HANDOFFS.md)
                dispatched = sync_dispatch(notion, dispatch_db, warroom)
                if dispatched:
                    print(f"📥 Dispatched {dispatched} task(s) to HANDOFFS.md")

                # 2. Result sync (HANDOFFS.md -> Notion). Must run every loop; this closes the loop.
                pushed = sync_results(notion, warroom)
                if pushed:
                    print(f"✅ Pushed {pushed} completed result(s) back to Notion")

                # 3. Live observability (CURRENT_STATE.md -> Notion dashboard block)
                if push_state_to_notion(notion, state_block, warroom):
                    print("📡 CURRENT_STATE.md upserted into Notion dashboard block.")

            except Exception as exc:
                print(f"⚠️ Bridge sync error: {exc!r}; backing off 30s")
                time.sleep(30)
                continue

            time.sleep(poll_seconds)

    except KeyboardInterrupt:
        print("\n🛑 Gracefully shutting down Notion Bridge.")
        sys.exit(0)

if __name__ == "__main__":
    main()
