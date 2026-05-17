"""Bridge state store with file locking and atomic JSON persistence.

The bridge keeps idempotency state in a single JSON sidecar inside the War
Room directory:

```
<WARROOM_PATH>/.notion_bridge_state.json
<WARROOM_PATH>/.notion_bridge.lock
```

`StateStore` owns reads/writes to that sidecar and the cross-process lock that
guards every multi-step bridge mutation (context snapshot -> handoff append ->
state write -> Notion status update).

State file shape (per plan.md section 5):

```json
{
  "version": 1,
  "command_center_data_source_id": "data-source-id-or-null",
  "dashboard_block_id": "block-id-or-null",
  "pages": {
    "<notion-page-id>": {
      "handoff_key": "wrb_abcd1234",
      "context_path": "/home/alhinai/WarRoom/NotionInbox/wrb_abcd1234.md",
      "last_notion_status": "Dispatched",
      "last_local_status": "PENDING",
      "last_result_hash": "sha256...",
      "last_next_action_hash": "sha256...",
      "last_result_block_id": "block-id-or-null",
      "last_synced_at": "2026-05-17T12:00:00Z"
    }
  }
}
```
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Mapping, Optional

from filelock import FileLock


LOCK_FILENAME = ".notion_bridge.lock"
STATE_FILENAME = ".notion_bridge_state.json"
SCHEMA_VERSION = 1
HANDOFF_KEY_PREFIX = "wrb_"
HANDOFF_KEY_HEX_LENGTH = 12
DEFAULT_LOCK_TIMEOUT_SECONDS = 30.0


class StateStoreError(RuntimeError):
    """Raised when the state file is missing/corrupt or cannot be persisted."""


class UnknownHandoffKeyError(StateStoreError, KeyError):
    """Raised when an operation references a handoff key not in state."""


def handoff_key_for_page(page_id: str) -> str:
    """Stable bridge handoff key derived from a Notion page id.

    `wrb_` + first 12 hex chars of SHA-256(page_id). Deterministic so the
    bridge can rebuild the same key after a restart without consulting state.
    """
    if not page_id:
        raise ValueError("page_id is required")
    digest = hashlib.sha256(page_id.encode("utf-8")).hexdigest()
    return f"{HANDOFF_KEY_PREFIX}{digest[:HANDOFF_KEY_HEX_LENGTH]}"


def empty_state() -> dict[str, Any]:
    return {
        "version": SCHEMA_VERSION,
        "command_center_data_source_id": None,
        "dashboard_block_id": None,
        "mission_control": {},
        "pages": {},
        "kb_pages": {},
        "skill_pages": {},
    }


class StateStore:
    """JSON-backed state with a cross-process FileLock guard.

    Mutating helpers acquire the bridge lock for the duration of the call.
    Bulk operations (dispatch loop, result sync loop) should wrap their entire
    critical section with `with store.locked():` so the read-modify-write of
    state plus the surrounding local-file mutations and Notion API calls
    happen under a single lock acquisition. `FileLock` is reentrant in-thread,
    so nested helpers re-acquire harmlessly.
    """

    def __init__(
        self,
        warroom_path: os.PathLike | str,
        *,
        lock_timeout: float = DEFAULT_LOCK_TIMEOUT_SECONDS,
    ) -> None:
        if warroom_path is None:
            raise ValueError("warroom_path is required")
        self.warroom_path = Path(warroom_path)
        self.state_path = self.warroom_path / STATE_FILENAME
        self.lock_path = self.warroom_path / LOCK_FILENAME
        self.lock_timeout = float(lock_timeout)
        self._lock = FileLock(str(self.lock_path), timeout=self.lock_timeout)

    # ---- Lock management -----------------------------------------------------

    @property
    def lock(self) -> FileLock:
        return self._lock

    @contextmanager
    def locked(self) -> Iterator["StateStore"]:
        """Hold the bridge lock for the body of a critical section."""
        self.warroom_path.mkdir(parents=True, exist_ok=True)
        with self._lock:
            yield self

    # ---- Persistence ---------------------------------------------------------

    def load(self) -> dict[str, Any]:
        """Return current state, or an empty skeleton if the file is absent."""
        if not self.state_path.exists():
            return empty_state()
        try:
            with self.state_path.open("r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            raise StateStoreError(
                f"could not read state file {self.state_path}: {exc}"
            ) from exc
        if not isinstance(data, dict):
            raise StateStoreError(
                f"state file is not a JSON object: {self.state_path}"
            )
        data.setdefault("version", SCHEMA_VERSION)
        data.setdefault("command_center_data_source_id", None)
        data.setdefault("dashboard_block_id", None)
        mission_control = data.get("mission_control")
        if not isinstance(mission_control, dict):
            data["mission_control"] = {}
        pages = data.get("pages")
        if not isinstance(pages, dict):
            data["pages"] = {}
        kb_pages = data.get("kb_pages")
        if not isinstance(kb_pages, dict):
            data["kb_pages"] = {}
        skill_pages = data.get("skill_pages")
        if not isinstance(skill_pages, dict):
            data["skill_pages"] = {}
        return data

    def save(self, state: Mapping[str, Any]) -> None:
        """Persist state via temp file + os.replace for atomic rename."""
        if not isinstance(state, Mapping):
            raise TypeError("state must be a mapping")
        self.warroom_path.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(
            prefix=".notion_bridge_state.",
            suffix=".tmp",
            dir=str(self.warroom_path),
        )
        tmp_path = Path(tmp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(state, f, indent=2, sort_keys=True)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, self.state_path)
        except BaseException:
            try:
                tmp_path.unlink()
            except FileNotFoundError:
                pass
            raise

    # ---- Required helpers ----------------------------------------------------

    @staticmethod
    def handoff_key_for_page(page_id: str) -> str:
        return handoff_key_for_page(page_id)

    def get_page_by_key(self, key: str) -> Optional[dict[str, Any]]:
        """Return the page entry for a handoff key, or None if absent.

        The returned dict is a copy and includes the synthesized `page_id`
        field so callers can identify the Notion page without a second
        lookup.
        """
        if not key:
            return None
        state = self.load()
        for page_id, entry in (state.get("pages") or {}).items():
            if isinstance(entry, Mapping) and entry.get("handoff_key") == key:
                result = dict(entry)
                result["page_id"] = page_id
                return result
        return None

    def mark_dispatched(
        self,
        key: str,
        page_id: str,
        *,
        context_path: Optional[str] = None,
        last_notion_status: str = "Dispatched",
        last_local_status: str = "PENDING",
        last_synced_at: Optional[str] = None,
        last_sync_hash: Optional[str] = None,
    ) -> dict[str, Any]:
        """Record that a Notion page has been turned into a War Room handoff.

        Idempotent: re-calling with the same `page_id` updates the existing
        entry in place rather than creating a duplicate. Other fields are
        preserved if not overridden by the call.
        """
        if not key:
            raise ValueError("key is required")
        if not page_id:
            raise ValueError("page_id is required")
        with self.locked():
            state = self.load()
            pages = state.setdefault("pages", {})
            existing = pages.get(page_id) or {}
            entry = dict(existing) if isinstance(existing, Mapping) else {}
            entry["handoff_key"] = key
            if context_path is not None:
                entry["context_path"] = str(context_path)
            else:
                entry.setdefault("context_path", None)
            entry["last_notion_status"] = last_notion_status
            entry["last_local_status"] = last_local_status
            if last_synced_at is not None:
                entry["last_synced_at"] = last_synced_at
            else:
                entry.setdefault("last_synced_at", None)
            if last_sync_hash is not None:
                entry["last_sync_hash"] = last_sync_hash
            entry.setdefault("last_result_hash", None)
            entry.setdefault("last_next_action_hash", None)
            entry.setdefault("last_result_block_id", None)
            pages[page_id] = entry
            self.save(state)
            return dict(entry)

    def mark_result_synced(
        self,
        key: str,
        result_hash: str,
        *,
        next_action_hash: Optional[str] = None,
        last_local_status: Optional[str] = None,
        last_notion_status: Optional[str] = None,
        last_synced_at: Optional[str] = None,
        last_result_block_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Record that the bridge pushed a result update for `key` to Notion.

        Requires that `key` already corresponds to a dispatched page. Raises
        `UnknownHandoffKeyError` otherwise so the caller doesn't silently
        create an orphan record.
        """
        if not key:
            raise ValueError("key is required")
        if result_hash is None:
            raise ValueError("result_hash is required")
        with self.locked():
            state = self.load()
            pages = state.get("pages") or {}
            target_page_id: Optional[str] = None
            for pid, entry in pages.items():
                if isinstance(entry, Mapping) and entry.get("handoff_key") == key:
                    target_page_id = pid
                    break
            if target_page_id is None:
                raise UnknownHandoffKeyError(
                    f"no page with handoff key {key!r} in state"
                )
            entry = dict(pages[target_page_id])
            entry["last_result_hash"] = result_hash
            if next_action_hash is not None:
                entry["last_next_action_hash"] = next_action_hash
            if last_local_status is not None:
                entry["last_local_status"] = last_local_status
            if last_notion_status is not None:
                entry["last_notion_status"] = last_notion_status
            if last_synced_at is not None:
                entry["last_synced_at"] = last_synced_at
            if last_result_block_id is not None:
                entry["last_result_block_id"] = last_result_block_id
            state["pages"][target_page_id] = entry
            self.save(state)
            return dict(entry)

    # ---- Convenience setters used by the dashboard / discovery flow ---------

    def set_command_center_data_source_id(
        self, data_source_id: Optional[str]
    ) -> None:
        with self.locked():
            state = self.load()
            state["command_center_data_source_id"] = data_source_id
            self.save(state)

    def set_dashboard_block_id(self, block_id: Optional[str]) -> None:
        with self.locked():
            state = self.load()
            state["dashboard_block_id"] = block_id
            self.save(state)

    @property
    def dashboard_block_id(self) -> Optional[str]:
        return self.load().get("dashboard_block_id")

    @property
    def dashboard_hash(self) -> Optional[str]:
        return self.load().get("dashboard_hash")

    def set_dashboard_hash(self, dash_hash: Optional[str]) -> None:
        with self.locked():
            state = self.load()
            state["dashboard_hash"] = dash_hash
            self.save(state)

    # ---- Mission Control multi-block state ----------------------------------

    def _mission_control_entry(
        self, state: Mapping[str, Any], section_name: str
    ) -> Optional[Mapping[str, Any]]:
        mc = state.get("mission_control")
        if not isinstance(mc, Mapping):
            return None
        entry = mc.get(section_name)
        if not isinstance(entry, Mapping):
            return None
        return entry

    def get_mission_control_block_id(self, section_name: str) -> Optional[str]:
        if not section_name:
            return None
        entry = self._mission_control_entry(self.load(), section_name)
        if entry is None:
            return None
        block_id = entry.get("block_id")
        return block_id if isinstance(block_id, str) else None

    def set_mission_control_block_id(
        self, section_name: str, block_id: Optional[str]
    ) -> None:
        if not section_name:
            raise ValueError("section_name is required")
        with self.locked():
            state = self.load()
            mc = state.setdefault("mission_control", {})
            if not isinstance(mc, dict):
                mc = {}
                state["mission_control"] = mc
            existing = mc.get(section_name)
            entry: dict[str, Any] = (
                dict(existing) if isinstance(existing, Mapping) else {}
            )
            entry["block_id"] = block_id
            entry.setdefault("hash", None)
            mc[section_name] = entry
            self.save(state)

    def get_mission_control_hash(self, section_name: str) -> Optional[str]:
        if not section_name:
            return None
        entry = self._mission_control_entry(self.load(), section_name)
        if entry is None:
            return None
        content_hash = entry.get("hash")
        return content_hash if isinstance(content_hash, str) else None

    def set_mission_control_hash(
        self, section_name: str, content_hash: Optional[str]
    ) -> None:
        if not section_name:
            raise ValueError("section_name is required")
        with self.locked():
            state = self.load()
            mc = state.setdefault("mission_control", {})
            if not isinstance(mc, dict):
                mc = {}
                state["mission_control"] = mc
            existing = mc.get(section_name)
            entry: dict[str, Any] = (
                dict(existing) if isinstance(existing, Mapping) else {}
            )
            entry["hash"] = content_hash
            entry.setdefault("block_id", None)
            mc[section_name] = entry
            self.save(state)
    def get_mc_block(self, file_key: str) -> Optional[str]:
        mc = self.load().get("mission_control", {})
        if not isinstance(mc, dict):
            return None
        entry = mc.get(file_key)
        if not isinstance(entry, dict):
            return None
        block_id = entry.get("block_id")
        return block_id if isinstance(block_id, str) else None

    def set_mc_block(self, file_key: str, block_id: Optional[str]) -> None:
        self.set_mission_control_block_id(file_key, block_id)

    def get_mc_hash(self, file_key: str) -> Optional[str]:
        mc = self.load().get("mission_control", {})
        if not isinstance(mc, dict):
            return None
        entry = mc.get(file_key)
        if not isinstance(entry, dict):
            return None
        content_hash = entry.get("hash")
        return content_hash if isinstance(content_hash, str) else None

    def set_mc_hash(self, file_key: str, content_hash: Optional[str]) -> None:
        self.set_mission_control_hash(file_key, content_hash)

    # ---- Knowledge Base / Skill Inbox page tracking --------------------------

    def _get_section_page(
        self, top_level: str, section_key: str
    ) -> Optional[dict[str, Any]]:
        if not section_key:
            return None
        bucket = self.load().get(top_level)
        if not isinstance(bucket, dict):
            return None
        entry = bucket.get(section_key)
        if not isinstance(entry, dict):
            return None
        return dict(entry)

    def _set_section_page(
        self,
        top_level: str,
        section_key: str,
        page_id: Optional[str],
        content_hash: Optional[str],
    ) -> None:
        if not section_key:
            raise ValueError("section_key is required")
        with self.locked():
            state = self.load()
            bucket = state.get(top_level)
            if not isinstance(bucket, dict):
                bucket = {}
                state[top_level] = bucket
            if page_id is None:
                bucket.pop(section_key, None)
            else:
                bucket[section_key] = {
                    "page_id": page_id,
                    "hash": content_hash,
                }
            self.save(state)

    def get_kb_page(self, section_key: str) -> Optional[dict[str, Any]]:
        """Return the persisted `{page_id, hash}` for a KB section, or None."""
        return self._get_section_page("kb_pages", section_key)

    def set_kb_page(
        self,
        section_key: str,
        page_id: Optional[str],
        content_hash: Optional[str] = None,
    ) -> None:
        """Persist (or clear, when `page_id` is None) a KB page id and hash."""
        self._set_section_page("kb_pages", section_key, page_id, content_hash)

    def get_skill_page(self, section_key: str) -> Optional[dict[str, Any]]:
        """Return the persisted `{page_id, hash}` for a Skill Inbox section."""
        return self._get_section_page("skill_pages", section_key)

    def set_skill_page(
        self,
        section_key: str,
        page_id: Optional[str],
        content_hash: Optional[str] = None,
    ) -> None:
        """Persist (or clear, when `page_id` is None) a Skill Inbox page."""
        self._set_section_page("skill_pages", section_key, page_id, content_hash)
