import os
from dotenv import load_dotenv

def load_config():
    # Load .env first, then .env.local will override if it exists
    load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
    load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env.local'))
    cfg = {
        "NOTION_TOKEN": os.getenv("NOTION_TOKEN"),
        "NOTION_COMMAND_CENTER_DB_ID": os.getenv("NOTION_COMMAND_CENTER_DB_ID"),
        "NOTION_STATE_BLOCK_ID": os.getenv("NOTION_STATE_BLOCK_ID"),
        "NOTION_VERSION": os.getenv("NOTION_VERSION", "2025-09-03"),
        "WARROOM_PATH": os.path.expanduser(os.getenv("WARROOM_PATH", "~/WarRoom")),
        "POLL_SECONDS": int(os.getenv("POLL_SECONDS", "15"))
    }
    required = ["NOTION_TOKEN", "NOTION_COMMAND_CENTER_DB_ID", "NOTION_STATE_BLOCK_ID"]
    missing = [k for k in required if not cfg.get(k)]
    if missing:
        raise RuntimeError(f"Missing required env vars: {missing}")
    return cfg

def build_client(cfg):
    """Build a raw requests wrapper for Notion API 2025-09-03.
    The official Python SDK does not fully support the new data_sources split yet.
    """
    import requests
    class RawNotionClient:
        def __init__(self, token, version):
            self.session = requests.Session()
            self.session.headers.update({
                "Authorization": f"Bearer {token}",
                "Notion-Version": version,
                "Content-Type": "application/json"
            })
            self.base_url = "https://api.notion.com/v1"
            
        def query_database(self, db_id, payload):
            # Using the new 2025-09-03 data_sources endpoint
            url = f"{self.base_url}/data_sources/{db_id}/query"
            res = self.session.post(url, json=payload)
            res.raise_for_status()
            return res.json()
            
        def update_page(self, page_id, properties):
            url = f"{self.base_url}/pages/{page_id}"
            res = self.session.patch(url, json={"properties": properties})
            res.raise_for_status()
            return res.json()
            
        def update_block(self, block_id, code_payload):
            url = f"{self.base_url}/blocks/{block_id}"
            res = self.session.patch(url, json={"code": code_payload})
            res.raise_for_status()
            return res.json()
            
    return RawNotionClient(cfg["NOTION_TOKEN"], cfg["NOTION_VERSION"])
