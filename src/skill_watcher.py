"""Phase-Two: Watch local Skill_Inbox and register scripts in Notion Runbooks DB."""
import os
import logging
from typing import Optional
from src.notion_http import NotionHTTPClient

logger = logging.getLogger(__name__)

def sync_skills_to_notion(
    client: NotionHTTPClient,
    runbook_db_id: Optional[str],
    warroom_path: str
) -> int:
    if not runbook_db_id:
        return 0
        
    skills_path = os.path.join(warroom_path, "Skill_Inbox")
    os.makedirs(skills_path, exist_ok=True)
    
    synced_skills = 0
    for filename in os.listdir(skills_path):
        if filename.endswith(".py") or filename.endswith(".sh") or filename.endswith(".md"):
            marker = os.path.join(skills_path, f".{filename}.synced")
            if not os.path.exists(marker):
                try:
                    payload = {
                        "parent": {"type": "database_id", "database_id": runbook_db_id},
                        "properties": {
                            "Name": {"title": [{"text": {"content": filename}}]},
                            "Status": {"select": {"name": "Available"}},
                            "Type": {"select": {"name": "Local Script"}}
                        }
                    }
                    client.create_page(payload)
                    with open(marker, "w", encoding="utf-8") as f:
                        f.write("synced")
                    synced_skills += 1
                except Exception as e:
                    logger.error(f"Failed to sync skill {filename} to Notion: {e}")
                    continue
                    
    return synced_skills
