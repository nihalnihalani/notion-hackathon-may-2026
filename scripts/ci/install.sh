#!/usr/bin/env bash
set -euo pipefail

if ! command -v node-gyp >/dev/null 2>&1; then
  npm install --global --no-audit --no-fund node-gyp@12.3.0
fi

pnpm install --frozen-lockfile
pnpm --filter @forge/db db:generate
