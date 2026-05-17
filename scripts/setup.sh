#!/usr/bin/env bash
# Forge — developer onboarding script.
# Run from the repo root: `bash scripts/setup.sh`
set -euo pipefail

BOLD="\033[1m"
RED="\033[31m"
GREEN="\033[32m"
YELLOW="\033[33m"
BLUE="\033[34m"
RESET="\033[0m"

info()  { printf "${BLUE}==>${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}OK${RESET}  %s\n" "$*"; }
warn()  { printf "${YELLOW}WARN${RESET} %s\n" "$*"; }
fail()  { printf "${RED}FAIL${RESET} %s\n" "$*" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ---- 1. Node version -------------------------------------------------------
info "Checking Node.js version (>= 20 required)..."
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed. Install Node 20 from https://nodejs.org or via nvm: 'nvm install 20'."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node $(node -v) detected, but Forge requires Node 20+. Try 'nvm use' to pick up .nvmrc."
fi
ok "Node $(node -v)"

# ---- 2. pnpm ---------------------------------------------------------------
info "Checking pnpm (>= 9 required)..."
if ! command -v pnpm >/dev/null 2>&1; then
  fail "pnpm is not installed. Install: 'npm install -g pnpm@9' or 'corepack enable && corepack prepare pnpm@9 --activate'."
fi
PNPM_MAJOR="$(pnpm -v | cut -d. -f1)"
if [ "$PNPM_MAJOR" -lt 9 ]; then
  fail "pnpm $(pnpm -v) detected, but Forge requires pnpm 9+. Run: 'corepack prepare pnpm@9 --activate'."
fi
ok "pnpm $(pnpm -v)"

# ---- 3. ntn CLI ------------------------------------------------------------
info "Checking ntn CLI..."
if ! command -v ntn >/dev/null 2>&1; then
  warn "ntn CLI not found on PATH."
  printf "     Install with: ${BOLD}curl -fsSL https://ntn.dev | bash${RESET}\n"
  printf "     Then re-run: ${BOLD}bash scripts/setup.sh${RESET}\n"
  exit 1
fi
ok "ntn $(ntn --version 2>/dev/null || echo '(version unknown)')"

# ---- 4. .env ---------------------------------------------------------------
info "Checking .env file..."
if [ ! -f ".env" ]; then
  cp .env.example .env
  ok "Created .env from .env.example (fill in real values before running 'pnpm dev')"
else
  ok ".env already exists (left untouched)"
fi

# ---- 5. Install workspace dependencies ------------------------------------
info "Installing workspace dependencies with pnpm..."
# Respect the committed lockfile so every dev gets the exact resolution CI
# tests against. If you intentionally need to update a package, run
# `pnpm add <pkg>` (or `pnpm up`) — never bypass the lockfile here.
pnpm install
ok "Dependencies installed"

# ---- 6. ntn doctor ---------------------------------------------------------
info "Running 'ntn doctor'..."
if ! ntn doctor; then
  warn "ntn doctor reported issues. Resolve them before running the full Forge stack."
fi

# ---- 7. verify env (only if .env exists & has been filled in) -------------
if [ -f ".env" ]; then
  info "Running 'pnpm verify:env' against the existing .env..."
  if ! pnpm verify:env; then
    warn ".env has missing or malformed values. Fix them before 'pnpm dev'."
  fi
else
  warn "No .env file present, skipping env verification."
fi

# ---- 8. Next steps banner --------------------------------------------------
cat <<EOF

${BOLD}${GREEN}Forge is ready.${RESET}

Next steps:
  1. Fill in real values in ${BOLD}.env${RESET}
  2. Run ${BOLD}pnpm verify:env${RESET}      # validates every required env var is set
  3. Run ${BOLD}pnpm dev${RESET}             # starts the Next.js dashboard + workspace watchers
  4. Open ${BOLD}http://localhost:3000${RESET} and sign in with Notion

Docs:
  - PLAN.md — production plan (Parts II, III, V, VIII are the must-reads)
  - README.md — repo overview

EOF
