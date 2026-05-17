#!/usr/bin/env python3
"""Redis ↔ local-file mirror for `~/WarRoom/`.

Phase-B Redis migration glue. The bridge and other Redis-aware modules
now treat Redis as the source of truth, but the existing agent CLIs
(Hermes / OpenClaw / Codex / Claude) still expect a local filesystem
under `~/WarRoom/`. This script is the bidirectional sync that keeps
both views consistent.

Why a separate script in `scripts/`:

- `tests/test_no_unsafe_imports.py` scans `src/**/*.py` and
  `notion_warroom_bridge.py` only. `scripts/` is the deliberate escape
  hatch for processes that need broader privileges (file I/O outside
  the bridge boundary, atomic temp+rename, etc.).
- This is a watcher, not a courier. It is allowed to write inside
  `~/WarRoom/`. It must NEVER delete or rename pre-existing files
  unless the Redis side explicitly removed the corresponding key
  (and even then the operation is logged).

Mirrored scopes:

| Local artefact                           | Redis key family              |
|------------------------------------------|-------------------------------|
| `HANDOFFS.md`                            | rendered view (RedisStore)    |
| `CURRENT_STATE.md`, `SHARED_MEMORY.md`,  | `wr:file:<name>` strings      |
| `AGENT_ROLES.md`, `PROTOCOL.md`,         |                               |
| `SCHEDULE.md`, `PROJECTS.md`             |                               |
| `KnowledgeBase/**/*.md`                  | `wr:kb:<rel_path>` strings    |
|                                          | + `wr:kb:index` set           |
| `Skill_Inbox/**/*.md`                    | `wr:skill:<name>` strings     |
|                                          | + `wr:skill:index` set        |
| `NotionInbox/*.md`                       | `wr:notion_inbox:<wrb_key>`   |

Conflict resolution:

For each (key, file) pair the script keeps a sidecar entry at
`~/WarRoom/.redis_file_mirror_state.json` with the last observed
`(local_hash, redis_hash, local_mtime)`. On each tick:

1. Read local content + mtime and redis content; hash both.
2. If neither side moved vs. the sidecar → no-op.
3. If only one side moved → push that side onto the other.
4. If both moved → last-edit-wins by ISO timestamp. Local mtime is
   compared to `wr:meta:<name>:last_updated_at` (written by this
   script whenever it pushes a local edit into Redis). The newer
   side wins; the older side is overwritten and a WARN is logged.
5. Persist updated hashes back to the sidecar.

CLI:

    python scripts/redis_file_mirror.py --once          # one pass, exit
    python scripts/redis_file_mirror.py --interval 5    # loop every 5s
    python scripts/redis_file_mirror.py --dry-run       # don't write anything
    python scripts/redis_file_mirror.py --log-level INFO

`REDIS_URL` is loaded from `.env` (same pattern as the bridge).
"""

# This script lives outside `src/` deliberately. See module docstring.
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from dotenv import load_dotenv  # noqa: E402

from src.redis_store import RedisStore  # noqa: E402
from src.warroom_format import parse_handoffs  # noqa: E402


# ---- Configuration --------------------------------------------------------

WARROOM_PATH = Path(os.environ.get("WARROOM_PATH", "~/WarRoom")).expanduser().resolve()

HANDOFFS_FILE = WARROOM_PATH / "HANDOFFS.md"
STATE_FILE = WARROOM_PATH / ".redis_file_mirror_state.json"

# Plain-string files that are stored under `wr:file:<name>` in Redis.
# Anything not in this list is left alone by the "files" scope. HANDOFFS.md
# is handled separately because it is a materialised view, not a raw blob.
WARROOM_FILES = (
    "CURRENT_STATE.md",
    "SHARED_MEMORY.md",
    "AGENT_ROLES.md",
    "PROTOCOL.md",
    "SCHEDULE.md",
    "PROJECTS.md",
)

# Directory-scoped scopes.
KB_DIR = WARROOM_PATH / "KnowledgeBase"
SKILL_DIR = WARROOM_PATH / "Skill_Inbox"
NOTION_INBOX_DIR = WARROOM_PATH / "NotionInbox"

DEFAULT_INTERVAL = 5.0

log = logging.getLogger("redis_file_mirror")


# ---- Sidecar state --------------------------------------------------------


def _load_state() -> dict:
    """Load the per-key (local_hash, redis_hash, local_mtime) sidecar.

    Returns an empty dict-of-dicts on first run or if the file is corrupt.
    Each scope is its own subdict so collisions are impossible across
    file/kb/skill/notion-inbox namespaces.
    """
    if not STATE_FILE.exists():
        return {}
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _save_state(state: dict, *, dry_run: bool) -> None:
    """Atomically persist sidecar via temp + os.replace.

    Even in `--dry-run` we skip the write — the next real run will
    rediscover hashes anyway.
    """
    if dry_run:
        return
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(STATE_FILE.suffix + ".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, STATE_FILE)


# ---- Helpers --------------------------------------------------------------


def _utc_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _hash(text: Optional[str]) -> str:
    """Stable hash for nullable text. None and '' collapse to the same digest.

    That collapse is intentional: from the mirror's point of view "no file"
    and "empty file" are the same nothing-to-sync state, and a Redis miss
    (`None`) should not be flagged as a conflict against a missing local
    file.
    """
    if text is None:
        text = ""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _read_local(path: Path) -> tuple[Optional[str], Optional[float]]:
    """Return (text, mtime) or (None, None) when the file does not exist."""
    if not path.exists():
        return None, None
    try:
        return path.read_text(encoding="utf-8"), path.stat().st_mtime
    except (OSError, UnicodeDecodeError) as exc:
        log.warning("could not read %s: %s", path, exc)
        return None, None


def _atomic_write(path: Path, content: str, *, dry_run: bool) -> None:
    """Write content via temp + os.replace so partial writes can't leak.

    Caller is responsible for the dry-run gate when it needs to skip the
    parent mkdir as well, but we handle both here for safety.
    """
    if dry_run:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".redis_mirror_tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


def _delete_local(path: Path, *, dry_run: bool) -> None:
    """Delete a local file when Redis confirms the key is gone."""
    if dry_run or not path.exists():
        return
    try:
        path.unlink()
    except OSError as exc:
        log.warning("could not delete %s: %s", path, exc)


# ---- last_updated_at metadata --------------------------------------------
#
# These helpers live here, not in `src/redis_store.py`, because they are
# specific to the mirror's conflict-resolution strategy. The redis_store
# itself stays scope-pure.

_META_TS_PREFIX = "wr:meta"


def _meta_ts_key(scope: str, name: str) -> str:
    """Build the metadata key for a mirrored entry's last-write timestamp.

    `scope` mirrors the redis_store scope name (file, kb, skill,
    notion_inbox, handoffs).
    """
    return f"{_META_TS_PREFIX}:{scope}:{name}:last_updated_at"


def _set_meta_ts(store: RedisStore, scope: str, name: str, iso: str) -> None:
    store.r.set(_meta_ts_key(scope, name), iso)


def _get_meta_ts(store: RedisStore, scope: str, name: str) -> Optional[str]:
    return store.r.get(_meta_ts_key(scope, name))


def _iso_to_epoch(iso: Optional[str]) -> Optional[float]:
    """Best-effort parse of `_utc_iso()` output back to a unix timestamp."""
    if not iso:
        return None
    try:
        return datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc
        ).timestamp()
    except ValueError:
        return None


# ---- Generic key/file pair sync -----------------------------------------


def _sync_pair(
    *,
    scope: str,
    name: str,
    local_path: Path,
    redis_text: Optional[str],
    state: dict,
    store: RedisStore,
    dry_run: bool,
    push_redis,
    write_local,
    delete_local_fn,
    delete_redis_fn,
) -> Optional[str]:
    """Reconcile one (local_path, redis key) pair.

    Returns a short string label describing the action taken (for logging
    and tests) or None when no change happened. All side effects are
    delegated to callables so the same engine can drive every scope:

    - `push_redis(text)` writes `text` to Redis for this key.
    - `write_local(text)` writes `text` to `local_path` atomically.
    - `delete_local_fn()` removes the local file when Redis has dropped
      the key.
    - `delete_redis_fn()` removes the Redis key when the local file
      disappears (currently never invoked — see the no-delete constraint
      below).

    The sidecar is updated in `state[scope][name]`.
    """
    scope_state = state.setdefault(scope, {})
    prev = scope_state.get(name, {})

    local_text, local_mtime = _read_local(local_path)
    local_hash = _hash(local_text)
    redis_hash = _hash(redis_text)

    prev_local = prev.get("local_hash")
    prev_redis = prev.get("redis_hash")

    local_present = local_text is not None
    redis_present = redis_text is not None

    # First-run bootstrap. Sidecar is empty so we cannot tell which side
    # "changed"; populate by pushing whichever side has data. If both
    # sides have data the local wins (we treat the local filesystem as
    # ground truth for the FIRST sync of a brand-new mirror — operators
    # may have hand-edited files before standing the mirror up).
    if prev_local is None and prev_redis is None:
        if local_present and not redis_present:
            log.info("[%s/%s] bootstrap: push local → redis", scope, name)
            if not dry_run:
                push_redis(local_text)
                _set_meta_ts(store, scope, name, _utc_iso())
            scope_state[name] = {
                "local_hash": local_hash,
                "redis_hash": local_hash,
                "local_mtime": local_mtime,
            }
            return "bootstrap_push"
        if redis_present and not local_present:
            log.info("[%s/%s] bootstrap: write redis → local", scope, name)
            write_local(redis_text)
            new_mtime = local_path.stat().st_mtime if not dry_run and local_path.exists() else local_mtime
            scope_state[name] = {
                "local_hash": redis_hash,
                "redis_hash": redis_hash,
                "local_mtime": new_mtime,
            }
            return "bootstrap_write"
        if local_present and redis_present:
            if local_hash == redis_hash:
                # Identical content, no-op but seed the sidecar.
                scope_state[name] = {
                    "local_hash": local_hash,
                    "redis_hash": redis_hash,
                    "local_mtime": local_mtime,
                }
                return None
            log.warning(
                "[%s/%s] bootstrap conflict: both populated and differ; "
                "preferring local (treating disk as ground truth on first sync)",
                scope, name,
            )
            if not dry_run:
                push_redis(local_text)
                _set_meta_ts(store, scope, name, _utc_iso())
            scope_state[name] = {
                "local_hash": local_hash,
                "redis_hash": local_hash,
                "local_mtime": local_mtime,
            }
            return "bootstrap_conflict_local_wins"
        # Neither side has data — nothing to record.
        return None

    local_changed = local_hash != prev_local
    redis_changed = redis_hash != prev_redis

    if not local_changed and not redis_changed:
        return None

    # Pure local edit → push.
    if local_changed and not redis_changed:
        if not local_present:
            # Local was deleted by the user. We DO NOT delete the redis key
            # in this script's normal mode — plan §2 says we never delete
            # files; symmetrically, we don't delete data in Redis either.
            log.warning(
                "[%s/%s] local file disappeared; leaving redis key intact",
                scope, name,
            )
            scope_state[name] = {
                "local_hash": local_hash,
                "redis_hash": prev_redis,
                "local_mtime": None,
            }
            return "local_missing_no_op"
        log.info("[%s/%s] local changed → push to redis", scope, name)
        if not dry_run:
            push_redis(local_text)
            _set_meta_ts(store, scope, name, _utc_iso())
        scope_state[name] = {
            "local_hash": local_hash,
            "redis_hash": local_hash,
            "local_mtime": local_mtime,
        }
        return "push_local_to_redis"

    # Pure redis edit → write to disk.
    if redis_changed and not local_changed:
        if not redis_present:
            # Redis key was deleted out from under us. Delete the local
            # mirror to keep the two views consistent — explicitly logged.
            log.warning(
                "[%s/%s] redis key removed; deleting local file", scope, name
            )
            delete_local_fn()
            scope_state.pop(name, None)
            return "delete_local"
        log.info("[%s/%s] redis changed → write to local", scope, name)
        write_local(redis_text)
        new_mtime = (
            local_path.stat().st_mtime
            if not dry_run and local_path.exists()
            else local_mtime
        )
        scope_state[name] = {
            "local_hash": redis_hash,
            "redis_hash": redis_hash,
            "local_mtime": new_mtime,
        }
        return "write_redis_to_local"

    # Both changed → last-edit-wins.
    redis_ts = _iso_to_epoch(_get_meta_ts(store, scope, name))
    local_ts = local_mtime
    log.warning(
        "[%s/%s] both sides changed; resolving by timestamp "
        "(local_mtime=%s, redis_ts=%s)",
        scope, name, local_ts, redis_ts,
    )
    # Tie-break: if we have no redis timestamp, local wins. If we have no
    # local mtime (file missing), redis wins. Otherwise newer wins.
    local_wins: bool
    if local_ts is None and redis_ts is None:
        local_wins = True
    elif local_ts is None:
        local_wins = False
    elif redis_ts is None:
        local_wins = True
    else:
        local_wins = local_ts >= redis_ts

    if local_wins and local_present:
        if not dry_run:
            push_redis(local_text)
            _set_meta_ts(store, scope, name, _utc_iso())
        scope_state[name] = {
            "local_hash": local_hash,
            "redis_hash": local_hash,
            "local_mtime": local_mtime,
        }
        return "conflict_local_wins"
    if redis_present:
        write_local(redis_text)
        new_mtime = (
            local_path.stat().st_mtime
            if not dry_run and local_path.exists()
            else local_mtime
        )
        scope_state[name] = {
            "local_hash": redis_hash,
            "redis_hash": redis_hash,
            "local_mtime": new_mtime,
        }
        return "conflict_redis_wins"

    # Defensive fallback: both vanished concurrently.
    scope_state.pop(name, None)
    return "both_missing"


# ---- Scope: plain files ---------------------------------------------------


def _sync_warroom_files(state: dict, store: RedisStore, *, dry_run: bool) -> dict:
    """Sync the named top-level War Room *.md files (not HANDOFFS.md)."""
    actions: dict[str, str] = {}
    for name in WARROOM_FILES:
        local_path = WARROOM_PATH / name
        redis_text = store.get_file(name)
        action = _sync_pair(
            scope="file",
            name=name,
            local_path=local_path,
            redis_text=redis_text,
            state=state,
            store=store,
            dry_run=dry_run,
            push_redis=lambda t, n=name: store.set_file(n, t),
            write_local=lambda t, p=local_path: _atomic_write(p, t, dry_run=dry_run),
            delete_local_fn=lambda p=local_path: _delete_local(p, dry_run=dry_run),
            delete_redis_fn=lambda n=name: store.delete_file(n),
        )
        if action:
            actions[name] = action
    return actions


# ---- Scope: HANDOFFS.md (rendered view) -----------------------------------


def _sync_handoffs(state: dict, store: RedisStore, *, dry_run: bool) -> Optional[str]:
    """Reconcile HANDOFFS.md with the per-handoff Redis hashes.

    The Redis "current text" for this file is the result of
    `store.render_handoffs_md()`. A local edit means a human (or an
    agent) appended/modified a block in the .md file — we parse it,
    upsert each block into Redis, then re-render and overwrite the
    local file. The overwrite normalises any minor formatting drift so
    the two sides stay byte-identical going forward.
    """
    scope_state = state.setdefault("handoffs", {})
    prev = scope_state.get("HANDOFFS.md", {})

    redis_rendered = store.render_handoffs_md()
    local_text, local_mtime = _read_local(HANDOFFS_FILE)
    local_hash = _hash(local_text)
    redis_hash = _hash(redis_rendered)

    prev_local = prev.get("local_hash")
    prev_redis = prev.get("redis_hash")

    local_present = local_text is not None
    redis_present = bool(redis_rendered)  # render returns "" when no handoffs

    # Bootstrap: first run. Prefer local if it has content; otherwise
    # write redis-rendered text to disk.
    if prev_local is None and prev_redis is None:
        if local_present and local_text.strip():
            log.info("[handoffs] bootstrap: parse local HANDOFFS.md → upsert redis")
            _upsert_local_handoffs(store, local_text, dry_run=dry_run)
            re_rendered = store.render_handoffs_md()
            _atomic_write(HANDOFFS_FILE, re_rendered, dry_run=dry_run)
            new_mtime = HANDOFFS_FILE.stat().st_mtime if not dry_run and HANDOFFS_FILE.exists() else local_mtime
            scope_state["HANDOFFS.md"] = {
                "local_hash": _hash(re_rendered),
                "redis_hash": _hash(re_rendered),
                "local_mtime": new_mtime,
            }
            return "bootstrap_parse_local"
        if redis_present:
            log.info("[handoffs] bootstrap: write rendered redis → local")
            _atomic_write(HANDOFFS_FILE, redis_rendered, dry_run=dry_run)
            new_mtime = HANDOFFS_FILE.stat().st_mtime if not dry_run and HANDOFFS_FILE.exists() else local_mtime
            scope_state["HANDOFFS.md"] = {
                "local_hash": redis_hash,
                "redis_hash": redis_hash,
                "local_mtime": new_mtime,
            }
            return "bootstrap_write_local"
        # Both empty — seed the sidecar so we don't loop on the bootstrap branch.
        scope_state["HANDOFFS.md"] = {
            "local_hash": local_hash,
            "redis_hash": redis_hash,
            "local_mtime": local_mtime,
        }
        return None

    local_changed = local_hash != prev_local
    redis_changed = redis_hash != prev_redis

    if not local_changed and not redis_changed:
        return None

    if local_changed and not redis_changed:
        log.info("[handoffs] local edited → parse + upsert + re-render")
        if local_present:
            _upsert_local_handoffs(store, local_text, dry_run=dry_run)
        re_rendered = store.render_handoffs_md()
        _atomic_write(HANDOFFS_FILE, re_rendered, dry_run=dry_run)
        new_mtime = HANDOFFS_FILE.stat().st_mtime if not dry_run and HANDOFFS_FILE.exists() else local_mtime
        scope_state["HANDOFFS.md"] = {
            "local_hash": _hash(re_rendered),
            "redis_hash": _hash(re_rendered),
            "local_mtime": new_mtime,
        }
        return "parse_and_render"

    if redis_changed and not local_changed:
        log.info("[handoffs] redis-side handoff changed → re-render to local")
        _atomic_write(HANDOFFS_FILE, redis_rendered, dry_run=dry_run)
        new_mtime = HANDOFFS_FILE.stat().st_mtime if not dry_run and HANDOFFS_FILE.exists() else local_mtime
        scope_state["HANDOFFS.md"] = {
            "local_hash": redis_hash,
            "redis_hash": redis_hash,
            "local_mtime": new_mtime,
        }
        return "render_to_local"

    # Both changed: parse local AND let Redis-side wins layer on top via
    # re-render. The upsert is a merge (per-key), so locally-edited
    # handoffs become the source of truth for their own keys; handoffs
    # only present in Redis survive unchanged.
    log.warning("[handoffs] both sides changed; merging local upsert with redis state")
    if local_present:
        _upsert_local_handoffs(store, local_text, dry_run=dry_run)
    re_rendered = store.render_handoffs_md()
    _atomic_write(HANDOFFS_FILE, re_rendered, dry_run=dry_run)
    new_mtime = HANDOFFS_FILE.stat().st_mtime if not dry_run and HANDOFFS_FILE.exists() else local_mtime
    scope_state["HANDOFFS.md"] = {
        "local_hash": _hash(re_rendered),
        "redis_hash": _hash(re_rendered),
        "local_mtime": new_mtime,
    }
    return "merge_conflict"


def _upsert_local_handoffs(store: RedisStore, text: str, *, dry_run: bool) -> None:
    """Parse a local HANDOFFS.md and upsert every well-formed block.

    Field name mapping mirrors `RedisStore.upsert_handoff(**fields)` which
    expects the lowercase/underscored field names (task, owner, etc.).
    Unknown bridge keys are skipped silently by `parse_handoffs`.
    """
    if dry_run:
        return
    for key, fields in parse_handoffs(text):
        store.upsert_handoff(
            key,
            task=fields.get("Task", ""),
            owner=fields.get("Owner", ""),
            files_touched=fields.get("Files Touched", ""),
            status=fields.get("Status", ""),
            result=fields.get("Result", ""),
            next_action=fields.get("Next Action", ""),
        )


# ---- Scope: KnowledgeBase --------------------------------------------------


def _sync_kb(state: dict, store: RedisStore, *, dry_run: bool) -> dict:
    """Walk KnowledgeBase/**/*.md and reconcile with `wr:kb:*`."""
    actions: dict[str, str] = {}
    local_rels: set[str] = set()
    if KB_DIR.exists():
        for path in KB_DIR.rglob("*.md"):
            if not path.is_file():
                continue
            rel = path.relative_to(KB_DIR).as_posix()
            local_rels.add(rel)

    redis_rels = set(store.list_kb_docs())
    all_rels = local_rels | redis_rels

    for rel in sorted(all_rels):
        local_path = KB_DIR / rel
        redis_text = store.get_kb_doc(rel)
        action = _sync_pair(
            scope="kb",
            name=rel,
            local_path=local_path,
            redis_text=redis_text,
            state=state,
            store=store,
            dry_run=dry_run,
            push_redis=lambda t, r=rel: store.set_kb_doc(r, t),
            write_local=lambda t, p=local_path: _atomic_write(p, t, dry_run=dry_run),
            delete_local_fn=lambda p=local_path: _delete_local(p, dry_run=dry_run),
            delete_redis_fn=lambda r=rel: store.delete_kb_doc(r),
        )
        if action:
            actions[rel] = action
    return actions


# ---- Scope: Skill_Inbox ---------------------------------------------------


def _sync_skills(state: dict, store: RedisStore, *, dry_run: bool) -> dict:
    """Walk Skill_Inbox/**/*.md and reconcile with `wr:skill:*`."""
    actions: dict[str, str] = {}
    local_names: set[str] = set()
    if SKILL_DIR.exists():
        for path in SKILL_DIR.rglob("*.md"):
            if not path.is_file():
                continue
            # Skills are flat by name (the redis_store key is just `<name>`),
            # but we tolerate nested dirs by using the relative posix path
            # as the name — that keeps it round-trippable.
            name = path.relative_to(SKILL_DIR).as_posix()
            local_names.add(name)

    redis_names = set(store.list_skills())
    all_names = local_names | redis_names

    for name in sorted(all_names):
        local_path = SKILL_DIR / name
        redis_text = store.get_skill(name)
        action = _sync_pair(
            scope="skill",
            name=name,
            local_path=local_path,
            redis_text=redis_text,
            state=state,
            store=store,
            dry_run=dry_run,
            push_redis=lambda t, n=name: store.set_skill(n, t),
            write_local=lambda t, p=local_path: _atomic_write(p, t, dry_run=dry_run),
            delete_local_fn=lambda p=local_path: _delete_local(p, dry_run=dry_run),
            delete_redis_fn=lambda n=name: store.delete_skill(n),
        )
        if action:
            actions[name] = action
    return actions


# ---- Scope: NotionInbox ---------------------------------------------------


def _notion_inbox_local_keys() -> set[str]:
    if not NOTION_INBOX_DIR.exists():
        return set()
    keys: set[str] = set()
    for path in NOTION_INBOX_DIR.glob("*.md"):
        if path.is_file():
            keys.add(path.stem)  # wrb_xxxxxxxxxxxx
    return keys


def _notion_inbox_redis_keys(store: RedisStore) -> set[str]:
    # No index set in the redis_store for notion inbox; scan via raw client.
    keys: set[str] = set()
    for full_key in store.r.scan_iter(match="wr:notion_inbox:*"):
        keys.add(full_key.split(":", 2)[2])
    return keys


def _sync_notion_inbox(state: dict, store: RedisStore, *, dry_run: bool) -> dict:
    """Reconcile NotionInbox/<wrb_key>.md with `wr:notion_inbox:<wrb_key>`."""
    actions: dict[str, str] = {}
    local_keys = _notion_inbox_local_keys()
    redis_keys = _notion_inbox_redis_keys(store)
    for key in sorted(local_keys | redis_keys):
        local_path = NOTION_INBOX_DIR / f"{key}.md"
        redis_text = store.get_notion_inbox(key)
        action = _sync_pair(
            scope="notion_inbox",
            name=key,
            local_path=local_path,
            redis_text=redis_text,
            state=state,
            store=store,
            dry_run=dry_run,
            push_redis=lambda t, k=key: store.set_notion_inbox(k, t),
            write_local=lambda t, p=local_path: _atomic_write(p, t, dry_run=dry_run),
            delete_local_fn=lambda p=local_path: _delete_local(p, dry_run=dry_run),
            delete_redis_fn=lambda k=key: store.r.delete(f"wr:notion_inbox:{k}"),
        )
        if action:
            actions[key] = action
    return actions


# ---- Main cycle -----------------------------------------------------------


def run_once(store: RedisStore, *, dry_run: bool) -> dict:
    """One full mirror pass; return per-scope action dict for tests/log."""
    WARROOM_PATH.mkdir(parents=True, exist_ok=True)
    state = _load_state()

    results: dict[str, dict] = {
        "files": _sync_warroom_files(state, store, dry_run=dry_run),
        "handoffs": {"HANDOFFS.md": _sync_handoffs(state, store, dry_run=dry_run)},
        "kb": _sync_kb(state, store, dry_run=dry_run),
        "skill": _sync_skills(state, store, dry_run=dry_run),
        "notion_inbox": _sync_notion_inbox(state, store, dry_run=dry_run),
    }
    # Drop None handoff entry if nothing happened.
    if results["handoffs"]["HANDOFFS.md"] is None:
        results["handoffs"] = {}

    _save_state(state, dry_run=dry_run)
    return results


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Redis ↔ ~/WarRoom/ file mirror. Polls both sides and "
        "reconciles them. Default mode actually writes; use --dry-run "
        "to see what would change without touching disk or Redis.",
    )
    parser.add_argument(
        "--once", action="store_true",
        help="Run one full mirror pass and exit (useful for tests/demos).",
    )
    parser.add_argument(
        "--interval", type=float, default=DEFAULT_INTERVAL,
        help=f"Polling interval in seconds (default {DEFAULT_INTERVAL})",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Log the actions that would be taken; do not write anywhere.",
    )
    parser.add_argument(
        "--log-level", default="INFO",
        help="DEBUG / INFO / WARNING / ERROR",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    load_dotenv()
    try:
        store = RedisStore()
    except Exception as exc:
        log.error("could not connect to Redis: %s", exc)
        return 2

    mode = "DRY-RUN" if args.dry_run else "LIVE"
    log.info("redis file mirror starting (%s)  warroom=%s", mode, WARROOM_PATH)

    if args.once:
        run_once(store, dry_run=args.dry_run)
        return 0

    try:
        while True:
            try:
                run_once(store, dry_run=args.dry_run)
            except Exception:
                log.exception("mirror cycle failed; continuing")
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log.info("interrupted; shutting down")
        return 0


if __name__ == "__main__":
    sys.exit(main())
