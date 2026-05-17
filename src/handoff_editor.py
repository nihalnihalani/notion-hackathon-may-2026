import re
from pathlib import Path
from src.state_store import StateStore

def update_handoff_block(handoffs_path: Path, handoff_key: str, store: StateStore, **kwargs):
    """Update specific fields of a handoff block in HANDOFFS.md safely."""
    if not handoffs_path.exists():
        return False
    
    with store.locked():
        text = handoffs_path.read_text()
        
        pattern = re.compile(r"^(- Task:(?:(?!\n- Task:).)*?" + re.escape(f"[{handoff_key}]") + r".*?(?=\n- Task:|\Z))", re.MULTILINE | re.DOTALL)
        match = pattern.search(text)
        if not match:
            return False
            
        block = match.group(1)
        new_block = block
        
        for k, v in kwargs.items():
            if v is None: continue
            field_pattern = re.compile(rf"^(\s*{k}:)\s*(.*)$", re.MULTILINE)
            if field_pattern.search(new_block):
                leading = field_pattern.search(new_block).group(1)
                new_block = field_pattern.sub(f"{leading} {v}", new_block)
            else:
                new_block += f"\n  {k}: {v}"
                
        text = text.replace(block, new_block)
        handoffs_path.write_text(text)
    return True
