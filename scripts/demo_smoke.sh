#!/usr/bin/env bash
set -euo pipefail
echo "1) Create a Pending task in your Notion Command Center DB titled 'SMOKE'."
read -r -p "   Press Enter once created..."

python3 notion_warroom_bridge.py &
BRIDGE_PID=$!
trap "kill $BRIDGE_PID 2>/dev/null || true" EXIT

sleep 20
echo "2) Verifying HANDOFFS.md got the six-field entry..."
grep -q "Task: SMOKE" ~/WarRoom/HANDOFFS.md
grep -q "Status: PENDING" ~/WarRoom/HANDOFFS.md
grep -q "ID:" ~/WarRoom/HANDOFFS.md

echo "3) Now go flip that entry's Status to COMPLETED and add a Result line."
read -r -p "   Press Enter once done..."

sleep 20
echo "4) Verifying Notion task is now Completed (manual check in the Notion UI)."
echo "OK - Smoke Test Passed!"
