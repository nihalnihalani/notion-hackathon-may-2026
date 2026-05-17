import os
import hashlib

FILES_TO_SYNC = {
    "CURRENT_STATE.md": "markdown",
    "HANDOFFS.md": "markdown",
    "SHARED_MEMORY.md": "markdown",
    "KnowledgeBase/INDEX.md": "markdown",
    "SKILL_REGISTRY.md": "markdown",
    "PROTOCOL.md": "markdown",
    ".notion_bridge_state.json": "json"
}

MAX_CHARS = 1949
TRUNCATE_MSG = "\n... [TRUNCATED]"

def get_file_content(filepath):
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
            if not content.strip():
                return "[ File not initialized or empty ]"
            return content
    except FileNotFoundError:
        return "[ File not initialized or empty ]"

def truncate_content(content):
    if len(content) > MAX_CHARS:
        return content[:MAX_CHARS] + TRUNCATE_MSG
    return content

def compute_hash(content):
    return hashlib.sha256(content.encode("utf-8")).hexdigest()

def sync_mission_control(client, dashboard_page_id, warroom_path, store):
    for filename, language in FILES_TO_SYNC.items():
        filepath = os.path.join(warroom_path, filename)
        content = get_file_content(filepath)
        truncated_content = truncate_content(content)
        content_hash = compute_hash(truncated_content)
        
        stored_hash = store.get_mc_hash(filename)
        if stored_hash == content_hash:
            continue
            
        block_id = store.get_mc_block(filename)
        
        payload = {
            "type": "code",
            "code": {
                "language": language,
                "rich_text": [
                    {
                        "type": "text",
                        "text": {
                            "content": truncated_content
                        }
                    }
                ]
            }
        }
        
        success = False
        if block_id:
            try:
                client.update_block(block_id, payload)
                success = True
            except Exception:
                block_id = None
                
        if not block_id:
            try:
                response = client.append_block_children(dashboard_page_id, children=[payload])
                if response and "results" in response and len(response["results"]) > 0:
                    new_block_id = response["results"][0]["id"]
                    store.set_mc_block(filename, new_block_id)
                    success = True
            except Exception:
                pass
                
        if success:
            store.set_mc_hash(filename, content_hash)
