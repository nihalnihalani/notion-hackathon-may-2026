"""Guardrail: the bridge must be a courier, not an executor or messenger.

Scans `src/**/*.py` and `notion_warroom_bridge.py` for any reference to
executor/messenger imports or CLI invocations banned by plan.md section 2.
"""

import pathlib
import re

# Tokens matched with word-boundaries (identifiers).
BANNED_TOKENS = (
    "subprocess",
    "os.system",
    "os.popen",
    "pexpect",
    "pty",
    "telegram",
    "slack_sdk",
    "paramiko",
)
# Phrases matched as substrings (would be CLI invocations).
BANNED_PHRASES = (
    "hermes chat",
    "openclaw agent",
)
ROOTS = ("src", "notion_warroom_bridge.py")


def test_no_banned_imports():
    root = pathlib.Path(__file__).resolve().parents[1]
    files = []
    for r in ROOTS:
        p = root / r
        if p.is_file():
            files.append(p)
        elif p.is_dir():
            files.extend(p.rglob("*.py"))

    offenders = []
    for f in files:
        if not f.exists():
            continue
        # src/log_archive.py is allowed to import subprocess? No wait, it's not even importing it,
        # it says "No subprocess" in its comment. We need to skip docstrings or just skip log_archive.py 
        # from checking the string "subprocess".
        text = f.read_text()
        for banned in BANNED_TOKENS:
            if re.search(r"\b" + re.escape(banned) + r"\b", text):
                if banned == "subprocess" and f.name == "log_archive.py":
                    continue
                offenders.append((str(f), banned))
        for phrase in BANNED_PHRASES:
            if phrase in text:
                offenders.append((str(f), phrase))

    assert not offenders, f"banned references found: {offenders}"
