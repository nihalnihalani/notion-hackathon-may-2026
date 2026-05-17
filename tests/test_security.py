import pytest
from src.dispatch_sync import sanitize_path_field, sanitize_text_field, sanitize_multiline

def test_sanitize_path_field():
    assert sanitize_path_field("../../../etc/passwd") == "."
    assert sanitize_path_field("/etc/passwd") == "."
    assert sanitize_path_field("~/.bashrc") == "."
    assert sanitize_path_field("$HOME") == "."
    assert sanitize_path_field("src/main.py, ../config.py") == "src/main.py, ."
    assert sanitize_path_field("src/main.py") == "src/main.py"

def test_sanitize_text_field():
    assert sanitize_text_field("$(rm -rf /)") == "(rm -rf /)"
    assert sanitize_text_field("title `ls`") == "title ls"
    assert sanitize_text_field("cmd | other & foo;") == "cmd  other  foo"

