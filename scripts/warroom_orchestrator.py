#!/usr/bin/env python3
"""Compatibility entry point for the vetted handoff watcher.

Historically this script contained a separate agent-dispatch loop. That
duplicated `scripts/handoff_watcher.py`, drifted from the actual CLI
interfaces, and missed the watcher state/logging safeguards. Keep this
filename for anyone who still runs it, but delegate all behavior to the
single vetted implementation.
"""

from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from handoff_watcher import main  # noqa: E402


if __name__ == "__main__":
    sys.exit(main())
