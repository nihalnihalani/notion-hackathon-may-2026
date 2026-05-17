import subprocess
import sys
from pathlib import Path

def test_daemon_help():
    """Verify the daemon parses args and prints help without crashing."""
    result = subprocess.run(
        [sys.executable, "notion_warroom_bridge.py", "--help"],
        capture_output=True,
        text=True
    )
    assert result.returncode == 0
    assert "Notion <-> War Room Bridge Daemon" in result.stdout
    assert "--once" in result.stdout

def test_daemon_banned_imports_smoke():
    """Double-check the main entrypoint doesn't import banned modules."""
    text = Path("notion_warroom_bridge.py").read_text()
    banned = ["subprocess", "os.system", "pty", "telegram"]
    for b in banned:
        assert b not in text, f"Banned import/call {b} found in daemon script."
