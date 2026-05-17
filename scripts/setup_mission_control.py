#!/usr/bin/env python3
"""One-time setup: create the Mission Control page tree in Notion.

Creates:
- A "🪖 Mission Control" parent page under NOTION_DASHBOARD_PAGE_ID.
- Five child pages, one per Mission Control section, each pre-populated
  with the current War Room snapshot.

Persists all created page/block IDs into `.notion_bridge_state.json`
under a new top-level key `mission_control_pages` so the daemon can
later refresh each child page's body block in place.

Re-running this script is safe: existing pages/blocks are detected via
the state file and skipped (no duplicates created).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.config import build_client, load_config
from src.mission_control_sync import (  # noqa: E402
    _code_block_payload,
    _format_block_text,
    _sections,
)
from src.state_store import StateStore  # noqa: E402


PARENT_TITLE = "🪖 Mission Control"
PARENT_INTRO = (
    "Bridge-owned status board. Each child page below mirrors a War Room "
    "source file and updates in place when the bridge daemon runs."
)


def _intro_blocks() -> list[dict]:
    return [
        {
            "type": "paragraph",
            "paragraph": {
                "rich_text": [
                    {"type": "text", "text": {"content": PARENT_INTRO}}
                ]
            },
        }
    ]


def _ensure_parent(client, dashboard_page_id: str, store: StateStore) -> str:
    state = store.load()
    existing = state.get("mission_control_parent_id")
    if existing:
        print(f"[skip] Mission Control parent already exists: {existing}")
        return existing

    print(f"[create] Mission Control parent under {dashboard_page_id} ...")
    response = client.create_page(
        parent_page_id=dashboard_page_id,
        title=PARENT_TITLE,
        children=_intro_blocks(),
    )
    page_id = response.get("id")
    if not page_id:
        raise RuntimeError(f"Notion did not return a page id: {response!r}")

    state = store.load()
    state["mission_control_parent_id"] = page_id
    store.save(state)
    print(f"[ok]   Mission Control parent created: {page_id}")
    return page_id


def _ensure_section_page(
    client,
    parent_page_id: str,
    section_key: str,
    title: str,
    body_text: str,
    store: StateStore,
) -> tuple[str, Optional[str]]:
    """Ensure one section child page + body block exist. Returns (page_id, block_id)."""
    state = store.load()
    pages = state.setdefault("mission_control_pages", {})
    entry = pages.get(section_key) or {}
    page_id = entry.get("page_id")
    block_id = entry.get("block_id")

    if page_id and block_id:
        print(f"[skip] {title}: page={page_id} block={block_id}")
        return page_id, block_id

    if not page_id:
        print(f"[create] {title} (page)...")
        page_resp = client.create_page(parent_page_id=parent_page_id, title=title)
        page_id = page_resp.get("id")
        if not page_id:
            raise RuntimeError(f"create_page returned no id for {section_key}")

    print(f"[create] {title} (body block)...")
    block_resp = client.append_block_children(page_id, [_code_block_payload(body_text)])
    results = block_resp.get("results") or []
    if results and isinstance(results[0], dict):
        block_id = results[0].get("id")

    state = store.load()
    pages = state.setdefault("mission_control_pages", {})
    pages[section_key] = {"page_id": page_id, "block_id": block_id}
    store.save(state)
    print(f"[ok]   {title}: page={page_id} block={block_id}")
    return page_id, block_id


def main() -> int:
    env_file = REPO_ROOT / ".env"
    config = load_config(env_file=env_file if env_file.exists() else None)
    client = build_client(config)
    store = StateStore(config.warroom_path)

    if not config.notion_dashboard_page_id:
        print("error: NOTION_DASHBOARD_PAGE_ID is not set")
        return 1

    print("--- Mission Control page tree setup ---")
    mc_parent_id = _ensure_parent(client, config.notion_dashboard_page_id, store)

    warroom = Path(config.warroom_path)
    sections = _sections(warroom)
    print(f"\nCreating {len(sections)} section child pages under {mc_parent_id}...")
    for section_key, title, renderer in sections:
        body = renderer(warroom)
        text = _format_block_text(title, body)
        _ensure_section_page(client, mc_parent_id, section_key, title, text, store)

    print("\n--- Done ---")
    print(f"Open the Mission Control page in Notion to see the result.")
    print(f"Parent page id: {mc_parent_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
