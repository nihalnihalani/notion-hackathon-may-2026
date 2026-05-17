"""Config loader for the Notion War Room bridge.

Loads environment variables from a .env file plus the process environment,
validates the values required by the bridge daemon, and returns a frozen
dataclass that the rest of the code can rely on.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional

from dotenv import dotenv_values
from src.notion_http import NotionHTTPClient


class ConfigError(RuntimeError):
    """Raised when required configuration is missing or invalid."""


@dataclass(frozen=True)
class Config:
    notion_token: str
    notion_version: str
    notion_dashboard_page_id: str
    notion_command_center_data_source_id: Optional[str]
    notion_command_center_database_id: Optional[str]
    notion_history_block_id: Optional[str]
    notion_memory_block_id: Optional[str]
    notion_protocol_block_id: Optional[str]
    notion_roles_block_id: Optional[str]
    notion_knowledge_base_db_id: Optional[str]
    notion_runbook_db_id: Optional[str]
    warroom_path: Path
    poll_seconds: int


DEFAULT_NOTION_VERSION = "2025-09-03"
DEFAULT_WARROOM_PATH = "~/WarRoom"
DEFAULT_POLL_SECONDS = 5


def _expand_path(raw: str) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(raw))).resolve()


def _coerce_int(name: str, raw: str, default: int) -> int:
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc


def load_config(
    env_file: Optional[os.PathLike] = None,
    environ: Optional[Mapping[str, str]] = None,
) -> Config:
    """Load and validate bridge configuration."""
    file_values: dict[str, str] = {}
    if env_file is not None:
        env_path = Path(env_file)
        if not env_path.exists():
            raise ConfigError(f"env file not found: {env_path}")
        file_values = {k: v for k, v in dotenv_values(env_path).items() if v is not None}

    process_env: Mapping[str, str] = environ if environ is not None else os.environ

    def get(name: str) -> Optional[str]:
        value = process_env.get(name)
        if value is None or value == "":
            value = file_values.get(name)
        if value is None or value == "":
            return None
        return value

    token = get("NOTION_TOKEN")
    if not token:
        raise ConfigError("NOTION_TOKEN is required")

    dashboard_page_id = get("NOTION_DASHBOARD_PAGE_ID")
    if not dashboard_page_id:
        raise ConfigError("NOTION_DASHBOARD_PAGE_ID is required")

    data_source_id = get("NOTION_COMMAND_CENTER_DATA_SOURCE_ID")
    database_id = get("NOTION_COMMAND_CENTER_DATABASE_ID")
    if not data_source_id and not database_id:
        raise ConfigError(
            "either NOTION_COMMAND_CENTER_DATA_SOURCE_ID or "
            "NOTION_COMMAND_CENTER_DATABASE_ID is required"
        )

    warroom_raw = get("WARROOM_PATH") or DEFAULT_WARROOM_PATH
    warroom_path = _expand_path(warroom_raw)

    poll_seconds = _coerce_int(
        "POLL_SECONDS", get("POLL_SECONDS") or "", DEFAULT_POLL_SECONDS
    )

    return Config(
        notion_token=token,
        notion_version=get("NOTION_VERSION") or DEFAULT_NOTION_VERSION,
        notion_dashboard_page_id=dashboard_page_id,
        notion_command_center_data_source_id=data_source_id,
        notion_command_center_database_id=database_id,
        notion_history_block_id=get("NOTION_HISTORY_BLOCK_ID"),
        notion_memory_block_id=get("NOTION_MEMORY_BLOCK_ID"),
        notion_protocol_block_id=get("NOTION_PROTOCOL_BLOCK_ID"),
        notion_roles_block_id=get("NOTION_ROLES_BLOCK_ID"),
        notion_knowledge_base_db_id=get("NOTION_KNOWLEDGE_BASE_DB_ID"),
        notion_runbook_db_id=get("NOTION_RUNBOOK_DB_ID"),
        warroom_path=warroom_path,
        poll_seconds=poll_seconds,
    )

def build_client(cfg: Config) -> NotionHTTPClient:
    return NotionHTTPClient(token=cfg.notion_token, notion_version=cfg.notion_version)
