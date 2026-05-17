import os
from pathlib import Path
from dotenv import load_dotenv

def load_config(env_path=".env"):
    load_dotenv(dotenv_path=env_path)
    
    token = os.getenv("NOTION_TOKEN")
    if not token:
        raise ValueError("Missing required configuration: NOTION_TOKEN")
        
    dashboard_id = os.getenv("NOTION_DASHBOARD_PAGE_ID")
    if not dashboard_id:
        raise ValueError("Missing required configuration: NOTION_DASHBOARD_PAGE_ID")
        
    ds_id = os.getenv("NOTION_COMMAND_CENTER_DATA_SOURCE_ID")
    db_id = os.getenv("NOTION_COMMAND_CENTER_DATABASE_ID")
    if not ds_id and not db_id:
        raise ValueError("Missing required configuration: Must provide either NOTION_COMMAND_CENTER_DATA_SOURCE_ID or NOTION_COMMAND_CENTER_DATABASE_ID")
        
    warroom_path_str = os.getenv("WARROOM_PATH", "~/WarRoom")
    warroom_path = Path(warroom_path_str).expanduser().resolve()
    
    return {
        "NOTION_TOKEN": token,
        "NOTION_DASHBOARD_PAGE_ID": dashboard_id,
        "NOTION_COMMAND_CENTER_DATA_SOURCE_ID": ds_id,
        "NOTION_COMMAND_CENTER_DATABASE_ID": db_id,
        "WARROOM_PATH": str(warroom_path)
    }
