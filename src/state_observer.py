"""Backwards-compatibility shim: dashboard sync lives in `src.dashboard_sync`.

This module is kept so existing imports of `src.state_observer` continue to
work. The canonical name per plan.md Task 8 is `src.dashboard_sync`.
"""

from src.dashboard_sync import (  # noqa: F401
    MAX_BLOCK_LEN,
    STATE_FILE,
    push_state_to_notion,
    safe_truncate_markdown,
    sync_dashboard,
)
