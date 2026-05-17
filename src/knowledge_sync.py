"""Phase-Two: Sync Notion Database to local KnowledgeBase folder."""
import os
import logging
from typing import Optional
from src.notion_http import NotionHTTPClient

logger = logging.getLogger(__name__)

def sync_knowledge_base(
    client: NotionHTTPClient,
    kb_db_id: Optional[str],
    warroom_path: str
) -> int:
    if not kb_db_id:
        return 0
        
    kb_path = os.path.join(warroom_path, "KnowledgeBase")
    os.makedirs(kb_path, exist_ok=True)
    
    try:
        response = client.query_data_source(kb_db_id, {"page_size": 100})
    except Exception as e:
        logger.error(f"Failed to query Knowledge Base DB: {e}")
        return 0
        
    downloaded = 0
    for page in response.get("results", []):
        try:
            props = page.get("properties", {})
            # Look for the title property
            title = "Untitled"
            for k, v in props.items():
                if v.get("type") == "title":
                    title_parts = v.get("title", [])
                    if title_parts:
                        title = title_parts[0].get("plain_text", "Untitled")
                    break
                    
            page_id = page["id"].replace("-", "")
            safe_title = title.replace("/", "_").replace(" ", "_")
            file_path = os.path.join(kb_path, f"{safe_title}.md")
            
            # Simple sync: just write a stub file with the Notion ID
            # A full markdown sync requires traversing all child blocks, which is heavy for the bridge
            # and violates the "Bridge is a courier, not a heavy executor" rule if done inline.
            if not os.path.exists(file_path):
                with open(file_path, "w", encoding="utf-8") as f:
                    f.write(f"# {title}\n\nSynced from Notion Page ID: {page_id}\n")
                downloaded += 1
        except Exception as e:
            logger.debug(f"Failed to sync KB page {page.get('id')}: {e}")
            continue
            
    return downloaded
