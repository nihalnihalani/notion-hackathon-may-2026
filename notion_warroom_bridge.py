import os
import sys
import time
import argparse
from pathlib import Path

from src.config import load_config, build_client
from src.state_store import StateStore
from src.dispatch_sync import sync_dispatch
from src.result_sync import sync_results
from src.state_observer import push_state_to_notion

def main():
    parser = argparse.ArgumentParser(description="Notion <-> War Room Bridge Daemon")
    parser.add_argument("--once", action="store_true", help="Run sync loop exactly once and exit")
    args = parser.parse_args()

    print("🚀 Starting Notion <-> War Room Bridge Daemon (V6 Final MVP)...")
    base_dir = Path(__file__).parent.resolve()
    config = load_config(env_file=base_dir / ".env")
    
    print("Building client...")
    notion = build_client(config) 

    warroom = str(config.warroom_path)
    dispatch_db = config.notion_command_center_database_id or config.notion_command_center_data_source_id
    state_block = config.notion_dashboard_page_id if getattr(config, 'notion_state_block_id', None) is None else getattr(config, 'notion_state_block_id', config.notion_dashboard_page_id)
    if os.getenv("NOTION_STATE_BLOCK_ID"):
        state_block = os.getenv("NOTION_STATE_BLOCK_ID")

    print(f"Polling seconds: {config.poll_seconds}")
    print(f"Dispatch DB: {dispatch_db}")
    print(f"State block: {state_block}")
    
    store = StateStore(warroom)

    try:
        while True:
            try:
                print("Running sync_dispatch...")
                dispatched = sync_dispatch(notion, dispatch_db, warroom, store=store)
                if dispatched:
                    print(f"📥 Dispatched {dispatched} task(s) to HANDOFFS.md")

                print("Running sync_results...")
                pushed = sync_results(notion, warroom, store=store)
                if pushed:
                    print(f"✅ Pushed {pushed} completed result(s) back to Notion")

                print("Running push_state_to_notion...")
                if push_state_to_notion(notion, state_block, Path(warroom), store):
                    print("📡 CURRENT_STATE.md upserted into Notion dashboard block.")

            except Exception as exc:
                import traceback
                traceback.print_exc()
                print(f"⚠️ Bridge sync error: {exc!r}; backing off 30s")
                if args.once:
                    print("🛑 Exiting because --once flag was set.")
                    break
                time.sleep(30)
                continue

            if args.once:
                print("🛑 Exiting because --once flag was set.")
                break

            print("Sleeping...")
            time.sleep(config.poll_seconds)

    except KeyboardInterrupt:
        print("\n🛑 Gracefully shutting down Notion Bridge.")
        sys.exit(0)

if __name__ == "__main__":
    main()
