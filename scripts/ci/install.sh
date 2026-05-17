#!/usr/bin/env bash
set -euo pipefail

pnpm install --frozen-lockfile
pnpm --filter @forge/db db:generate
