import pytest
from src.dispatch_sync import sanitize_path_field, sanitize_text_field, sanitize_multiline

def test_sanitize_path_field():
    # Path traversal segments collapse to "." (untrusted glob escape)
    assert sanitize_path_field("../../../etc/passwd") == "."
    assert sanitize_path_field("src/main.py, ../config.py") == "src/main.py, ."
    # Absolute paths and ~ are preserved — plan demo requires them.
    assert sanitize_path_field("/home/alhinai/WarRoom/**") == "/home/alhinai/WarRoom/**"
    assert sanitize_path_field("~/WarRoom/HANDOFFS.md") == "~/WarRoom/HANDOFFS.md"
    assert sanitize_path_field("src/main.py") == "src/main.py"
    # Shell metacharacters are stripped.
    assert sanitize_path_field("$HOME/foo") == "HOME/foo"
    assert sanitize_path_field("foo`bar") == "foobar"

def test_sanitize_text_field():
    assert sanitize_text_field("$(rm -rf /)") == "(rm -rf /)"
    assert sanitize_text_field("title `ls`") == "title ls"
    assert sanitize_text_field("cmd | other & foo;") == "cmd  other  foo"

