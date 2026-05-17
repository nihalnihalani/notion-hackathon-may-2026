import os
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.config import (  # noqa: E402
    DEFAULT_NOTION_VERSION,
    Config,
    ConfigError,
    load_config,
)

LOCAL_ENV = Path("/home/alhinai/projects/notion-os/.env")


def _base_env(**overrides):
    env = {
        "NOTION_TOKEN": "ntn_test_token",
        "NOTION_DASHBOARD_PAGE_ID": "dash_page_id",
        "NOTION_COMMAND_CENTER_DATA_SOURCE_ID": "ds_id_123",
        "WARROOM_PATH": "/tmp/war-room-test",
        "POLL_SECONDS": "7",
    }
    env.update(overrides)
    return env


def test_loads_local_env_file():
    assert LOCAL_ENV.exists(), "expected the local .env to be in place"
    cfg = load_config(env_file=LOCAL_ENV, environ={})
    assert cfg.notion_token.startswith("ntn_")
    assert cfg.notion_version == DEFAULT_NOTION_VERSION
    assert cfg.notion_dashboard_page_id
    # The .env we created provides a data source id.
    assert cfg.notion_command_center_data_source_id
    assert cfg.warroom_path.is_absolute()


def test_missing_token_raises():
    env = _base_env()
    env.pop("NOTION_TOKEN")
    with pytest.raises(ConfigError, match="NOTION_TOKEN"):
        load_config(environ=env)


def test_missing_dashboard_page_id_raises():
    env = _base_env()
    env.pop("NOTION_DASHBOARD_PAGE_ID")
    with pytest.raises(ConfigError, match="NOTION_DASHBOARD_PAGE_ID"):
        load_config(environ=env)


def test_data_source_id_accepted():
    env = _base_env(NOTION_COMMAND_CENTER_DATA_SOURCE_ID="ds_123")
    env.pop("NOTION_COMMAND_CENTER_DATABASE_ID", None)
    cfg = load_config(environ=env)
    assert cfg.notion_command_center_data_source_id == "ds_123"
    assert cfg.notion_command_center_database_id is None


def test_database_id_fallback_accepted():
    env = _base_env()
    env.pop("NOTION_COMMAND_CENTER_DATA_SOURCE_ID", None)
    env["NOTION_COMMAND_CENTER_DATABASE_ID"] = "db_999"
    cfg = load_config(environ=env)
    assert cfg.notion_command_center_database_id == "db_999"
    assert cfg.notion_command_center_data_source_id is None


def test_missing_both_source_and_database_raises():
    env = _base_env()
    env.pop("NOTION_COMMAND_CENTER_DATA_SOURCE_ID", None)
    env.pop("NOTION_COMMAND_CENTER_DATABASE_ID", None)
    with pytest.raises(ConfigError, match="DATA_SOURCE_ID"):
        load_config(environ=env)


def test_tilde_warroom_path_expands():
    env = _base_env(WARROOM_PATH="~/WarRoomExpansionTest")
    cfg = load_config(environ=env)
    assert cfg.warroom_path.is_absolute()
    assert "~" not in str(cfg.warroom_path)
    assert str(cfg.warroom_path).endswith("WarRoomExpansionTest")


def test_relative_warroom_path_expands(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    env = _base_env(WARROOM_PATH="./relative-warroom")
    cfg = load_config(environ=env)
    assert cfg.warroom_path.is_absolute()
    assert cfg.warroom_path == (tmp_path / "relative-warroom").resolve()


def test_env_file_overridden_by_environ(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "NOTION_TOKEN=from_file\n"
        "NOTION_DASHBOARD_PAGE_ID=dash_from_file\n"
        "NOTION_COMMAND_CENTER_DATA_SOURCE_ID=ds_from_file\n"
    )
    cfg = load_config(env_file=env_file, environ={"NOTION_TOKEN": "from_environ"})
    assert cfg.notion_token == "from_environ"
    # values not set in environ fall through to file
    assert cfg.notion_dashboard_page_id == "dash_from_file"
    assert cfg.notion_command_center_data_source_id == "ds_from_file"


def test_poll_seconds_defaults_when_blank():
    env = _base_env()
    env["POLL_SECONDS"] = ""
    cfg = load_config(environ=env)
    assert cfg.poll_seconds == 5


def test_poll_seconds_invalid_raises():
    env = _base_env(POLL_SECONDS="not-an-int")
    with pytest.raises(ConfigError, match="POLL_SECONDS"):
        load_config(environ=env)


def test_config_is_frozen():
    cfg = load_config(environ=_base_env())
    assert isinstance(cfg, Config)
    with pytest.raises(Exception):
        cfg.notion_token = "mutated"  # type: ignore[misc]


def test_missing_env_file_raises(tmp_path):
    with pytest.raises(ConfigError, match="env file not found"):
        load_config(env_file=tmp_path / "does-not-exist.env", environ=_base_env())
