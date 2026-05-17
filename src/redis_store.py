"""Redis-backed storage for War Room state.

This module is the cloud-storage replacement for the local files under
`~/WarRoom/`. The bridge and the screen syncers used to read/write
markdown files directly; the rewrite (per user direction, Path B —
"aggressive Redis-backed") routes that I/O through this module.

Why Redis: the data model is dominated by key→blob and an append-only
log (HANDOFFS.md). Both are native Redis primitives. Postgres-grade
joins/queries don't apply — every War Room query is single-key.

## Key schema

| Pattern                        | Type   | What it stores                                        |
|--------------------------------|--------|-------------------------------------------------------|
| `wr:file:<name>`               | string | Plain markdown files (CURRENT_STATE, SHARED_MEMORY,   |
|                                |        | AGENT_ROLES, PROTOCOL, SCHEDULE, PROJECTS, etc.)      |
| `wr:handoff:<wrb_key>`         | hash   | One handoff: task, owner, files_touched, status,      |
|                                |        | result, next_action, context, last_updated_at         |
| `wr:handoffs:all`              | set    | All handoff keys (for full iteration)                 |
| `wr:handoffs:order`            | zset   | Handoff keys scored by first-dispatched timestamp     |
|                                |        | (for HANDOFFS.md render order)                        |
| `wr:handoffs:by_status:<S>`    | set    | Keys grouped by current status                        |
| `wr:notion_inbox:<wrb_key>`    | string | Context snapshot text (was NotionInbox/<key>.md)      |
| `wr:kb:<rel_path>`             | string | KnowledgeBase doc contents                            |
| `wr:kb:index`                  | set    | Relative paths of all KB docs                         |
| `wr:skill:<name>`              | string | Skill_Inbox doc contents                              |
| `wr:skill:index`               | set    | All skill names                                       |
| `wr:state:bridge`              | string | JSON blob = entire .notion_bridge_state.json          |
| `wr:lock`                      | string | SETNX-based cross-process lock                        |

All callers use the `RedisStore` class — no direct `r.get`/`r.set`
calls from the bridge code. That keeps the migration boundary in one
file and makes it easy to swap out the backend later if needed.

## Connection

Set `REDIS_URL` in the bridge's `.env`. Examples:

    REDIS_URL=rediss://default:<token>@<host>.upstash.io:6379  (Upstash TLS)
    REDIS_URL=redis://localhost:6379                            (local dev)

For tests, pass a `fakeredis.FakeRedis(decode_responses=True)` instance
to the constructor's `client=` arg — no env var or network needed.
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from contextlib import contextmanager
from typing import Iterator, Optional

import redis

log = logging.getLogger(__name__)


# Key prefixes — bumped to v1 so future migrations can use v2 without conflict.
_PREFIX = "wr"


def _k_file(name: str) -> str:
    return f"{_PREFIX}:file:{name}"


def _k_handoff(key: str) -> str:
    return f"{_PREFIX}:handoff:{key}"


def _k_notion_inbox(key: str) -> str:
    return f"{_PREFIX}:notion_inbox:{key}"


def _k_kb(rel_path: str) -> str:
    return f"{_PREFIX}:kb:{rel_path}"


def _k_skill(name: str) -> str:
    return f"{_PREFIX}:skill:{name}"


HANDOFF_FIELDS = (
    "task",
    "owner",
    "files_touched",
    "status",
    "result",
    "next_action",
    "context",
    "last_updated_at",
)


HANDOFFS_ALL = f"{_PREFIX}:handoffs:all"
HANDOFFS_ORDER = f"{_PREFIX}:handoffs:order"
KB_INDEX = f"{_PREFIX}:kb:index"
SKILL_INDEX = f"{_PREFIX}:skill:index"
BRIDGE_STATE = f"{_PREFIX}:state:bridge"
LOCK_KEY = f"{_PREFIX}:lock"


def _k_by_status(status: str) -> str:
    return f"{_PREFIX}:handoffs:by_status:{status}"


# Render order used when materialising HANDOFFS.md from Redis.
_OWNER_RENDER_ORDER = ("Hermes", "OpenClaw", "Codex", "User")


class RedisStoreError(RuntimeError):
    """Raised when the underlying Redis client misbehaves."""


class RedisStore:
    """One class wraps every War Room read/write the bridge needs.

    Construct with either:

        RedisStore()                                       # uses REDIS_URL env var
        RedisStore(url="redis://localhost:6379")           # explicit URL
        RedisStore(client=fakeredis.FakeRedis(decode_responses=True))  # tests
    """

    def __init__(
        self,
        url: Optional[str] = None,
        *,
        client: Optional["redis.Redis"] = None,
    ) -> None:
        if client is not None:
            self.r = client
        else:
            resolved_url = url or os.environ.get("REDIS_URL")
            if not resolved_url:
                raise RedisStoreError(
                    "REDIS_URL not set; pass url= or set the env var"
                )
            self.r = redis.from_url(resolved_url, decode_responses=True)

    # ---- File-style values ------------------------------------------------

    def get_file(self, name: str) -> Optional[str]:
        return self.r.get(_k_file(name))

    def set_file(self, name: str, content: str) -> None:
        self.r.set(_k_file(name), content)

    def delete_file(self, name: str) -> None:
        self.r.delete(_k_file(name))

    # ---- Handoffs (replaces HANDOFFS.md parsing) -------------------------

    def upsert_handoff(self, key: str, **fields: str) -> None:
        """Create or update one handoff. Maintains the indices.

        Reserved field names are listed in `HANDOFF_FIELDS`. Anything else
        passed in is stored verbatim so future fields don't need a schema
        bump.
        """
        if not key:
            raise ValueError("key is required")
        previous = self.get_handoff(key) or {}
        merged = dict(previous)
        for fname, value in fields.items():
            merged[fname] = "" if value is None else str(value)
        merged["last_updated_at"] = merged.get(
            "last_updated_at"
        ) or _utc_iso()
        # Atomic-ish: pipeline the four touched keys.
        pipe = self.r.pipeline()
        pipe.hset(_k_handoff(key), mapping=merged)
        pipe.sadd(HANDOFFS_ALL, key)
        # Score by first-seen timestamp so order is stable across upserts.
        if "created_at" not in previous:
            pipe.zadd(HANDOFFS_ORDER, {key: time.time()}, nx=True)
        # Re-index status set: remove from old, add to new.
        old_status = (previous.get("status") or "").upper()
        new_status = (merged.get("status") or "").upper()
        if old_status and old_status != new_status:
            pipe.srem(_k_by_status(old_status), key)
        if new_status:
            pipe.sadd(_k_by_status(new_status), key)
        pipe.execute()

    def get_handoff(self, key: str) -> Optional[dict]:
        data = self.r.hgetall(_k_handoff(key))
        return dict(data) if data else None

    def delete_handoff(self, key: str) -> None:
        prev = self.get_handoff(key) or {}
        old_status = (prev.get("status") or "").upper()
        pipe = self.r.pipeline()
        pipe.delete(_k_handoff(key))
        pipe.srem(HANDOFFS_ALL, key)
        pipe.zrem(HANDOFFS_ORDER, key)
        if old_status:
            pipe.srem(_k_by_status(old_status), key)
        pipe.execute()

    def list_handoff_keys(self) -> list[str]:
        """Return all handoff keys in stable (first-dispatched) order."""
        return list(self.r.zrange(HANDOFFS_ORDER, 0, -1)) or list(
            self.r.smembers(HANDOFFS_ALL)
        )

    def list_handoffs(self) -> list[dict]:
        keys = self.list_handoff_keys()
        if not keys:
            return []
        pipe = self.r.pipeline()
        for k in keys:
            pipe.hgetall(_k_handoff(k))
        out = []
        for k, data in zip(keys, pipe.execute()):
            if data:
                entry = dict(data)
                entry["_key"] = k
                out.append(entry)
        return out

    def list_handoff_keys_by_status(self, status: str) -> set[str]:
        return set(self.r.smembers(_k_by_status(status.upper())))

    def render_handoffs_md(self) -> str:
        """Materialise the bridge's HANDOFFS.md text from Redis.

        Format mirrors the on-disk protocol from plan.md §2 so existing
        parsers (and the local-file mirror) can still consume it.
        """
        handoffs = self.list_handoffs()
        if not handoffs:
            return ""
        lines: list[str] = []
        for entry in handoffs:
            title = entry.get("task") or "(untitled)"
            key = entry["_key"]
            lines.append(f"\n- Task: {title} [{key}]")
            lines.append(f"  Owner: {entry.get('owner') or ''}")
            lines.append(f"  Files Touched: {entry.get('files_touched') or ''}")
            lines.append(f"  Status: {entry.get('status') or 'PENDING'}")
            result_text = entry.get("result") or ""
            lines.append(f"  Result: {result_text}".rstrip())
            next_text = entry.get("next_action") or ""
            lines.append(f"  Next Action: {next_text}".rstrip())
        # Trailing newline keeps round-trip-with-the-old-format identical.
        return "\n".join(lines) + "\n"

    # ---- Notion-inbox context snapshots ---------------------------------

    def get_notion_inbox(self, handoff_key: str) -> Optional[str]:
        return self.r.get(_k_notion_inbox(handoff_key))

    def set_notion_inbox(self, handoff_key: str, body: str) -> None:
        self.r.set(_k_notion_inbox(handoff_key), body)

    # ---- KnowledgeBase --------------------------------------------------

    def get_kb_doc(self, rel_path: str) -> Optional[str]:
        return self.r.get(_k_kb(rel_path))

    def set_kb_doc(self, rel_path: str, content: str) -> None:
        pipe = self.r.pipeline()
        pipe.set(_k_kb(rel_path), content)
        pipe.sadd(KB_INDEX, rel_path)
        pipe.execute()

    def delete_kb_doc(self, rel_path: str) -> None:
        pipe = self.r.pipeline()
        pipe.delete(_k_kb(rel_path))
        pipe.srem(KB_INDEX, rel_path)
        pipe.execute()

    def list_kb_docs(self) -> list[str]:
        return sorted(self.r.smembers(KB_INDEX))

    # ---- Skill Inbox ----------------------------------------------------

    def get_skill(self, name: str) -> Optional[str]:
        return self.r.get(_k_skill(name))

    def set_skill(self, name: str, content: str) -> None:
        pipe = self.r.pipeline()
        pipe.set(_k_skill(name), content)
        pipe.sadd(SKILL_INDEX, name)
        pipe.execute()

    def delete_skill(self, name: str) -> None:
        pipe = self.r.pipeline()
        pipe.delete(_k_skill(name))
        pipe.srem(SKILL_INDEX, name)
        pipe.execute()

    def list_skills(self) -> list[str]:
        return sorted(self.r.smembers(SKILL_INDEX))

    # ---- Bridge state (JSON blob — same shape as the old sidecar file) -

    def get_bridge_state(self) -> dict:
        raw = self.r.get(BRIDGE_STATE)
        if not raw:
            return {}
        try:
            data = json.loads(raw)
            return data if isinstance(data, dict) else {}
        except (json.JSONDecodeError, ValueError):
            log.warning("bridge state in Redis is not valid JSON; returning {}")
            return {}

    def set_bridge_state(self, state: dict) -> None:
        if not isinstance(state, dict):
            raise TypeError("bridge state must be a dict")
        self.r.set(BRIDGE_STATE, json.dumps(state, indent=2, sort_keys=True))

    # ---- Cross-process lock (SETNX-based; mirrors the old filelock) ----

    @contextmanager
    def locked(self, *, timeout_seconds: float = 30.0) -> Iterator["RedisStore"]:
        """Acquire `wr:lock` with a fencing token; release on exit.

        Compatible with the old `StateStore.locked()` semantics: blocks
        until the lock is free or `timeout_seconds` elapses, then yields
        the store. Same RedisStore instance can re-enter (we use a fresh
        token per call but only the outermost release deletes the key).
        """
        token = uuid.uuid4().hex
        deadline = time.monotonic() + timeout_seconds
        acquired = False
        while time.monotonic() < deadline:
            if self.r.set(LOCK_KEY, token, nx=True, ex=int(timeout_seconds) + 5):
                acquired = True
                break
            time.sleep(0.05)
        if not acquired:
            raise RedisStoreError(
                f"could not acquire {LOCK_KEY} within {timeout_seconds}s"
            )
        try:
            yield self
        finally:
            # Lua-style check-and-delete to avoid releasing someone else's lock
            # if our TTL expired and another holder claimed it.
            current = self.r.get(LOCK_KEY)
            if current == token:
                self.r.delete(LOCK_KEY)

    # ---- Wipe (test/dev only) -------------------------------------------

    def wipe(self) -> None:
        """Delete every `wr:*` key. Useful for clean-state tests."""
        for key in list(self.r.scan_iter(match=f"{_PREFIX}:*")):
            self.r.delete(key)


# ---- Helpers ------------------------------------------------------------


def _utc_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
