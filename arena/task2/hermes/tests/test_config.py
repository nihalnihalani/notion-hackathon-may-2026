import pytest
import os
from pathlib import Path

# Provide a stub or copy of load_config here directly for testing the arena script independently.
def load_config(env_path=".env"):
    from dotenv import load_dotenv
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

def test_missing_token(monkeypatch, tmp_path):
    monkeypatch.delenv("NOTION_TOKEN", raising=False)
    monkeypatch.setenv("NOTION_DASHBOARD_PAGE_ID", "dash_id")
    monkeypatch.setenv("NOTION_COMMAND_CENTER_DATABASE_ID", "db_id")
    with pytest.raises(ValueError, match="NOTION_TOKEN"):
        load_config(tmp_path / ".env")



def test_data_source_id_accepted(monkeypatch, tmp_path):
    monkeypatch.setenv("NOTION_TOKEN", "token")
    monkeypatch.setenv("NOTION_DASHBOARD_PAGE_ID", "dash_id")
    monkeypatch.setenv("NOTION_COMMAND_CENTER_DATA_SOURCE_ID", "ds_id")
    monkeypatch.delenv("NOTION_COMMAND_CENTER_DATABASE_ID", raising=False)
    cfg = load_config(tmp_path / ".env")
    assert cfg["NOTION_COMMAND_CENTER_DATA_SOURCE_ID"] == "ds_id"

def test_database_id_fallback_accepted(monkeypatch, tmp_path):
    monkeypatch.setenv("NOTION_TOKEN", "token")
    monkeypatch.setenv("NOTION_DASHBOARD_PAGE_ID", "dash_id")
    monkeypatch.delenv("NOTION_COMMAND_CENTER_DATA_SOURCE_ID", raising=False)
    monkeypatch.setenv("NOTION_COMMAND_CENTER_DATABASE_ID", "db_id")
    cfg = load_config(tmp_path / ".env")
    assert cfg["NOTION_COMMAND_CENTER_DATABASE_ID"] == "db_id"

def test_relative_warroom_path_expands(monkeypatch, tmp_path):
    monkeypatch.setenv("NOTION_TOKEN", "token")
    monkeypatch.setenv("NOTION_DASHBOARD_PAGE_ID", "dash_id")
    monkeypatch.setenv("NOTION_COMMAND_CENTER_DATABASE_ID", "db_id")
    monkeypatch.setenv("WARROOM_PATH", "~/test_warroom")
    cfg = load_config(tmp_path / ".env")
    expected = str(Path("~/test_warroom").expanduser().resolve())
    assert cfg["WARROOM_PATH"] == expected
