"""Guardrail: the bridge must be a courier, not an executor or messenger."""
import pathlib

BANNED = ("subprocess", "os.system", "os.popen", "pexpect", "pty",
          "telegram", "slack_sdk", "paramiko")
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
        if not f.exists(): continue
        import re
        text = f.read_text()
        for banned in BANNED:
            # Word boundary regex check
            if re.search(r'\b' + re.escape(banned) + r'\b', text):
                offenders.append((str(f), banned))
                
    assert not offenders, f"banned references found: {offenders}"
