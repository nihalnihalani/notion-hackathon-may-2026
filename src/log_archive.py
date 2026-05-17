"""Rotating file log archive + simple search helpers.

Companion phase-two observability module. Wires a `RotatingFileHandler`
onto the root logger so the bridge daemon can persist its own log lines
to disk under the War Room directory, and offers a substring-search
helper that scans both the active file and its rotated siblings.

Design notes:

- This module is intentionally small and stdlib-only. No child processes, no
  shell-out, no third-party log shipper. The bridge stays a courier.
- `attach_file_logger` is idempotent: calling it twice for the same path
  is a no-op rather than installing duplicate handlers. We dedupe by
  comparing absolute paths against handlers already on the root logger.
- `search_log` is a case-insensitive substring search (not regex) so a
  user-supplied pattern cannot accidentally compile into something
  expensive or surprising.
"""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Union


DEFAULT_LOG_FILENAME = ".notion_bridge.log"
DEFAULT_MAX_BYTES = 1_000_000
DEFAULT_BACKUP_COUNT = 3

_LOG_FORMAT = "%(asctime)s %(name)s %(levelname)s %(message)s"


def _resolve_log_path(
    warroom_path: Union[Path, str], log_filename: str
) -> Path:
    """Build the absolute log path inside the War Room directory."""
    base = Path(warroom_path).expanduser().resolve()
    return (base / log_filename).resolve()


def _handler_path(handler: logging.Handler) -> Union[Path, None]:
    """Return the absolute file path a FileHandler writes to, or None."""
    base_filename = getattr(handler, "baseFilename", None)
    if not isinstance(base_filename, str) or not base_filename:
        return None
    try:
        return Path(base_filename).resolve()
    except (OSError, ValueError):
        return None


def attach_file_logger(
    warroom_path: Union[Path, str],
    *,
    log_filename: str = DEFAULT_LOG_FILENAME,
    level: int = logging.INFO,
    max_bytes: int = DEFAULT_MAX_BYTES,
    backup_count: int = DEFAULT_BACKUP_COUNT,
) -> Path:
    """Attach a `RotatingFileHandler` to the root logger.

    Returns the absolute path of the active log file. Safe to call
    repeatedly: subsequent calls with the same resolved path are no-ops
    so we do not duplicate handlers or duplicate every log line.

    The root logger's effective level is also widened (only widened, never
    narrowed) to make sure our new handler actually receives records at
    `level`.
    """
    log_path = _resolve_log_path(warroom_path, log_filename)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    root = logging.getLogger()
    for existing in root.handlers:
        existing_path = _handler_path(existing)
        if existing_path is not None and existing_path == log_path:
            # Already attached. Do not add a second handler.
            return log_path

    handler = RotatingFileHandler(
        filename=str(log_path),
        maxBytes=int(max_bytes),
        backupCount=int(backup_count),
        encoding="utf-8",
    )
    handler.setLevel(level)
    handler.setFormatter(logging.Formatter(_LOG_FORMAT))
    root.addHandler(handler)

    # Only widen the root level so our handler actually receives records.
    # Never narrow an existing user-configured level.
    if root.level == logging.NOTSET or root.level > level:
        root.setLevel(level)

    return log_path


def _iter_log_files(
    log_path: Path, *, include_rotated: bool
) -> list[Path]:
    """Return the active log file plus rotated siblings, newest-first.

    `RotatingFileHandler` writes `.log`, then rotates to `.log.1`,
    `.log.2`, etc. as the file fills. For newest-first iteration we read
    the active file first, then `.log.1`, then `.log.2`, etc.
    """
    files: list[Path] = []
    if log_path.exists():
        files.append(log_path)
    if not include_rotated:
        return files
    # Rotated files share the base name with a numeric suffix.
    parent = log_path.parent
    base_name = log_path.name
    if not parent.exists():
        return files
    rotated: list[tuple[int, Path]] = []
    for candidate in parent.iterdir():
        cname = candidate.name
        if not cname.startswith(base_name + "."):
            continue
        suffix = cname[len(base_name) + 1:]
        try:
            idx = int(suffix)
        except ValueError:
            continue
        if idx <= 0:
            continue
        if not candidate.is_file():
            continue
        rotated.append((idx, candidate))
    rotated.sort(key=lambda pair: pair[0])
    files.extend(p for _idx, p in rotated)
    return files


def search_log(
    warroom_path: Union[Path, str],
    pattern: str,
    *,
    log_filename: str = DEFAULT_LOG_FILENAME,
    limit: int = 50,
    include_rotated: bool = True,
) -> list[str]:
    """Return up to `limit` matching log lines, newest-first.

    `pattern` is treated as a case-insensitive substring. Returns an
    empty list when no log file exists, when `pattern` is empty, or when
    nothing matches.
    """
    if not pattern:
        return []
    if limit <= 0:
        return []

    log_path = _resolve_log_path(warroom_path, log_filename)
    files = _iter_log_files(log_path, include_rotated=include_rotated)
    if not files:
        return []

    needle = pattern.lower()
    results: list[str] = []

    for file_path in files:
        try:
            with file_path.open("r", encoding="utf-8", errors="replace") as f:
                # Within one file, newest lines are at the bottom, so we
                # read all lines then iterate in reverse.
                lines = f.readlines()
        except OSError:
            continue
        for line in reversed(lines):
            if needle in line.lower():
                results.append(line.rstrip("\n"))
                if len(results) >= limit:
                    return results

    return results
