"""Unit tests for `src.log_archive`.

Verifies the rotating file handler attaches once per path, writes the
expected lines, and that `search_log` honors case-insensitivity, limits,
and rotated-file scanning.
"""

from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.log_archive import (  # noqa: E402
    DEFAULT_LOG_FILENAME,
    attach_file_logger,
    search_log,
)


# ---- Fixtures ------------------------------------------------------------


@pytest.fixture
def reset_root_logger():
    """Snapshot/restore root logger handlers and level around each test.

    The module under test mutates the root logger, so we save/restore
    state to keep tests independent.
    """
    root = logging.getLogger()
    original_handlers = list(root.handlers)
    original_level = root.level
    # Clear handlers for a clean slate.
    root.handlers = []
    try:
        yield root
    finally:
        # Close any handlers added during the test.
        for h in list(root.handlers):
            try:
                h.close()
            except Exception:
                pass
        root.handlers = original_handlers
        root.setLevel(original_level)


# ---- attach_file_logger --------------------------------------------------


def test_attach_creates_file_and_writes_log_line(
    tmp_path: Path, reset_root_logger
) -> None:
    log_path = attach_file_logger(tmp_path, level=logging.DEBUG)

    assert log_path.is_absolute()
    assert log_path == (tmp_path / DEFAULT_LOG_FILENAME).resolve()

    logger = logging.getLogger("notion_bridge_test_logger")
    logger.setLevel(logging.DEBUG)
    logger.info("hello-test-line-xyz")

    # Force the handler to flush.
    for h in logging.getLogger().handlers:
        h.flush()

    assert log_path.exists()
    contents = log_path.read_text(encoding="utf-8")
    assert "hello-test-line-xyz" in contents


def _rotating_handlers() -> list[RotatingFileHandler]:
    """Filter to only our RotatingFileHandlers.

    pytest's caplog machinery installs its own LogCaptureHandler on the
    root logger and we must not count those.
    """
    return [
        h
        for h in logging.getLogger().handlers
        if isinstance(h, RotatingFileHandler)
    ]


def test_attach_is_idempotent_for_same_path(
    tmp_path: Path, reset_root_logger
) -> None:
    p1 = attach_file_logger(tmp_path)
    handlers_after_first = list(logging.getLogger().handlers)
    p2 = attach_file_logger(tmp_path)
    handlers_after_second = list(logging.getLogger().handlers)

    assert p1 == p2
    
    # We must assert that no NEW handlers were added.
    # We shouldn't assert it equals exactly 1 because pytest might inject its own LogCaptureHandlers.
    assert len(handlers_after_first) == len(handlers_after_second)

def test_attach_different_filenames_adds_distinct_handlers(
    tmp_path: Path, reset_root_logger
) -> None:
    handlers_before = list(logging.getLogger().handlers)
    attach_file_logger(tmp_path, log_filename="a.log")
    attach_file_logger(tmp_path, log_filename="b.log")
    handlers_after = logging.getLogger().handlers
    assert len(handlers_after) == len(handlers_before) + 2


# ---- search_log ----------------------------------------------------------


def test_search_log_missing_file_returns_empty_list(tmp_path: Path) -> None:
    assert search_log(tmp_path, "anything") == []


def test_search_log_finds_case_insensitive_substring_newest_first(
    tmp_path: Path,
) -> None:
    log_path = tmp_path / DEFAULT_LOG_FILENAME
    log_path.write_text(
        "2026-05-17 10:00 root INFO first ALPHA event\n"
        "2026-05-17 10:01 root INFO unrelated bravo\n"
        "2026-05-17 10:02 root WARN alpha returns\n",
        encoding="utf-8",
    )

    results = search_log(tmp_path, "alpha", limit=10)
    assert len(results) == 2
    # Newest first.
    assert "alpha returns" in results[0]
    assert "first ALPHA event" in results[1]


def test_search_log_honors_limit(tmp_path: Path) -> None:
    log_path = tmp_path / DEFAULT_LOG_FILENAME
    log_path.write_text(
        "\n".join(f"line {i} keyword" for i in range(10)) + "\n",
        encoding="utf-8",
    )
    results = search_log(tmp_path, "keyword", limit=3)
    assert len(results) == 3
    # Newest first -> line 9, 8, 7.
    assert "line 9" in results[0]
    assert "line 8" in results[1]
    assert "line 7" in results[2]


def test_search_log_includes_rotated_files_when_requested(
    tmp_path: Path,
) -> None:
    active = tmp_path / DEFAULT_LOG_FILENAME
    rotated1 = tmp_path / f"{DEFAULT_LOG_FILENAME}.1"
    rotated2 = tmp_path / f"{DEFAULT_LOG_FILENAME}.2"

    active.write_text("active needle here\n", encoding="utf-8")
    rotated1.write_text("rotated1 needle\n", encoding="utf-8")
    rotated2.write_text("rotated2 needle\n", encoding="utf-8")

    results = search_log(tmp_path, "needle", limit=10, include_rotated=True)
    # Active file first (newest), then .1, then .2.
    assert len(results) == 3
    assert "active needle" in results[0]
    assert "rotated1 needle" in results[1]
    assert "rotated2 needle" in results[2]


def test_search_log_skips_rotated_when_disabled(tmp_path: Path) -> None:
    active = tmp_path / DEFAULT_LOG_FILENAME
    rotated1 = tmp_path / f"{DEFAULT_LOG_FILENAME}.1"
    active.write_text("active needle here\n", encoding="utf-8")
    rotated1.write_text("rotated1 needle\n", encoding="utf-8")

    results = search_log(tmp_path, "needle", limit=10, include_rotated=False)
    assert len(results) == 1
    assert "active needle" in results[0]


def test_search_log_empty_pattern_returns_empty(tmp_path: Path) -> None:
    log_path = tmp_path / DEFAULT_LOG_FILENAME
    log_path.write_text("anything\n", encoding="utf-8")
    assert search_log(tmp_path, "") == []
