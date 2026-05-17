#!/usr/bin/env bash
# =============================================================================
# scripts/release.sh — bump version in root package.json, commit, tag, push.
#
# Usage:
#   ./scripts/release.sh patch     # 0.1.0 -> 0.1.1
#   ./scripts/release.sh minor     # 0.1.0 -> 0.2.0
#   ./scripts/release.sh major     # 0.1.0 -> 1.0.0
#   ./scripts/release.sh 1.2.3     # explicit version
#
# Requires:
#   - clean working tree (no uncommitted changes)
#   - jq + node + git on PATH
#   - upstream remote named `origin`
# =============================================================================
set -euo pipefail

BUMP="${1:-}"
if [ -z "${BUMP}" ]; then
  echo "usage: $0 <patch|minor|major|x.y.z>" >&2
  exit 1
fi

# --- preflight ---------------------------------------------------------------
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: working tree is dirty. Commit or stash before releasing." >&2
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "${BRANCH}" != "main" ]; then
  echo "ERROR: release must run from main (currently on ${BRANCH})." >&2
  exit 1
fi

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PKG="${ROOT}/package.json"
CURRENT=$(node -p "require('${PKG}').version")

# --- compute next version ----------------------------------------------------
if [[ "${BUMP}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEXT="${BUMP}"
else
  NEXT=$(node -e "
    const [maj, min, pat] = require('${PKG}').version.split('.').map(Number);
    const b = '${BUMP}';
    if (b === 'major') console.log(\`\${maj + 1}.0.0\`);
    else if (b === 'minor') console.log(\`\${maj}.\${min + 1}.0\`);
    else if (b === 'patch') console.log(\`\${maj}.\${min}.\${pat + 1}\`);
    else { console.error('unknown bump: ' + b); process.exit(1); }
  ")
fi

echo "Bumping ${CURRENT} -> ${NEXT}"

# --- write package.json ------------------------------------------------------
node -e "
  const fs = require('fs');
  const p = require('${PKG}');
  p.version = '${NEXT}';
  fs.writeFileSync('${PKG}', JSON.stringify(p, null, 2) + '\n');
"

# --- commit + tag + push -----------------------------------------------------
git add "${PKG}"
git commit -m "release: v${NEXT}"
git tag -a "v${NEXT}" -m "v${NEXT}"

git push origin "${BRANCH}"
git push origin "v${NEXT}"

echo "Released v${NEXT}"
