#!/usr/bin/env bash
# Forge local runner.
# Provides one entrypoint for setup, verification, tests, builds, and dev runs
# with consistent logging and optional debug output.
set -Eeuo pipefail

MODE="dev"
DEBUG_MODE="0"
SKIP_INSTALL="0"
VERIFY_ENV="1"
CI_ENV="0"
LOG_DIR="${LOG_DIR:-logs}"

usage() {
  cat <<'EOF'
Usage:
  ./run.sh [mode] [options]

Modes:
  dev            Start the full dev stack with pnpm dev. Default.
  check          Run install, env verification, lint, typecheck, test, build.
  test           Run the test suite.
  lint           Run lint only.
  typecheck      Run typecheck only.
  build          Run production build only.
  verify-env     Validate .env using scripts/verify-env.ts.
  setup          Create .env if missing and install dependencies.
  doctor         Run local dependency and ntn checks.

Options:
  --debug        Enable shell tracing, source maps, and verbose DEBUG channels.
  --ci-env       Export CI-shaped stub env values for local check/build runs.
  --skip-env     Skip pnpm verify:env before the selected mode.
  --no-install   Do not run scripts/ci/install.sh before command execution.
  --log-dir DIR  Write logs under DIR. Default: logs.
  -h, --help     Show this help.

Examples:
  ./run.sh dev --debug
  ./run.sh check --ci-env
  ./run.sh test --no-install --skip-env
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    dev|check|test|lint|typecheck|build|verify-env|setup|doctor)
      MODE="$1"
      shift
      ;;
    --debug)
      DEBUG_MODE="1"
      shift
      ;;
    --ci-env)
      CI_ENV="1"
      shift
      ;;
    --skip-env)
      VERIFY_ENV="0"
      shift
      ;;
    --no-install)
      SKIP_INSTALL="1"
      shift
      ;;
    --log-dir)
      if [ "${2:-}" = "" ]; then
        printf 'Missing value for --log-dir\n' >&2
        exit 2
      fi
      LOG_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

mkdir -p "$LOG_DIR"
RUN_ID="$(date -u '+%Y%m%dT%H%M%SZ')-${MODE}"
LOG_FILE="${LOG_DIR}/run-${RUN_ID}.log"
touch "$LOG_FILE"

exec > >(tee -a "$LOG_FILE") 2>&1

START_SECONDS="$(date +%s)"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
}

fail() {
  log "FAIL $*"
  exit 1
}

finish() {
  code="$?"
  elapsed="$(( $(date +%s) - START_SECONDS ))"
  if [ "$code" -eq 0 ]; then
    log "OK mode=${MODE} completed in ${elapsed}s"
  else
    log "FAIL mode=${MODE} exited with code ${code} after ${elapsed}s"
  fi
  log "Log file: ${LOG_FILE}"
  exit "$code"
}
trap finish EXIT

if [ "$DEBUG_MODE" = "1" ]; then
  export DEBUG="${DEBUG:-forge:*,next:*,turbo:*}"
  export NEXT_DEBUG="${NEXT_DEBUG:-1}"
  export TURBO_LOG_ORDER="${TURBO_LOG_ORDER:-stream}"
  case " ${NODE_OPTIONS:-} " in
    *" --enable-source-maps "*) ;;
    *) export NODE_OPTIONS="${NODE_OPTIONS:-} --enable-source-maps" ;;
  esac
  set -x
fi

export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
export TURBO_TELEMETRY_DISABLED="${TURBO_TELEMETRY_DISABLED:-1}"

ensure_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but was not found on PATH"
}

check_node() {
  ensure_command node
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 20 ]; then
    fail "Node $(node -v) detected; Forge requires Node 20+"
  fi
  log "Node $(node -v)"
}

check_pnpm() {
  ensure_command pnpm
  major="$(pnpm -v | cut -d. -f1)"
  if [ "$major" -lt 9 ]; then
    fail "pnpm $(pnpm -v) detected; Forge requires pnpm 9+"
  fi
  log "pnpm $(pnpm -v)"
}

check_ntn() {
  if command -v ntn >/dev/null 2>&1; then
    log "ntn $(ntn --version 2>/dev/null || printf 'version unavailable')"
  else
    log "WARN ntn CLI not found; install with: curl -fsSL https://ntn.dev | bash"
    return 1
  fi
}

ensure_env_file() {
  if [ ! -f ".env" ]; then
    cp .env.example .env
    chmod 600 .env
    log "Created local .env from .env.example. Fill in real secrets before dev/prod use."
  else
    log "Using existing local .env"
  fi
}

export_ci_stub_env() {
  log "Using CI-shaped stub environment for local verification only"
  export CI="true"
  export NEXT_PUBLIC_APP_URL="https://forge.example.com"
  export ANTHROPIC_API_KEY="sk-ant-fake-ci-stub"
  export OPENAI_API_KEY="sk-proj-fake-ci-stub-00000000000000000000"
  export OPENAI_ORG_ID="org-fake-ci-stub"
  export NOTION_OAUTH_CLIENT_ID="notion-fake-ci-stub"
  export NOTION_OAUTH_CLIENT_SECRET="notion-secret-fake-ci-stub"
  export NOTION_OAUTH_REDIRECT_URI="https://forge.example.com/api/auth/notion/callback"
  export NOTION_WEBHOOK_SECRET="notion-webhook-fake-ci-stub"
  export NTN_VERSION="0.1.x"
  export CLERK_SECRET_KEY="sk_test_fake_ci_stub"
  export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_test_fake_ci_stub"
  export CLERK_WEBHOOK_SECRET="whsec_fake_ci_stub"
  export CLERK_JWT_KEY="clerk-jwt-fake-ci-stub"
  export DATABASE_URL="postgres://user:pass@localhost:5432/forge"
  export VERCEL_AI_GATEWAY_API_KEY="gateway-fake-ci-stub"
  export VERCEL_BLOB_READ_WRITE_TOKEN="vercel_blob_rw_fake_ci_stub"
  export VERCEL_EDGE_CONFIG="https://edge-config.vercel.com/fake_ci_stub"
  export SENTRY_DSN="https://fake@o0.ingest.sentry.io/0"
  export NEXT_PUBLIC_SENTRY_DSN="https://fake@o0.ingest.sentry.io/0"
  export SENTRY_AUTH_TOKEN="sntrys_fake_ci_stub"
  export SENTRY_ORG="forge-dev"
  export SENTRY_PROJECT="forge-web"
  export POSTHOG_KEY="phc_fake_ci_stub"
  export NEXT_PUBLIC_POSTHOG_KEY="phc_fake_ci_stub"
  export RESEND_API_KEY="re_fake_ci_stub"
  export RESEND_FROM_EMAIL="forge@example.com"
  export UPSTASH_REDIS_REST_URL="https://fake.upstash.io"
  export UPSTASH_REDIS_REST_TOKEN="upstash-fake-ci-stub"
  export MINIMAX_API_KEY="minimax-fake-ci-stub"
  export MINIMAX_GROUP_ID="minimax-group-fake-ci-stub"
  export STRIPE_SECRET_KEY="sk_test_stripe_fake_ci_stub"
  export STRIPE_WEBHOOK_SECRET="whsec_stripe_fake_ci_stub"
  export FORGE_INTERNAL_TOKEN="ci_stub_token_0000000000000000000000000000000000000000000000"
}

install_dependencies() {
  if [ "$SKIP_INSTALL" = "1" ]; then
    log "Skipping dependency install"
    return
  fi
  log "Installing dependencies and generating Prisma client"
  bash scripts/ci/install.sh
}

verify_env() {
  if [ "$VERIFY_ENV" = "0" ]; then
    log "Skipping env verification"
    return
  fi
  log "Verifying environment"
  pnpm verify:env
}

run_doctor() {
  check_node
  check_pnpm
  check_ntn || true
  if command -v ntn >/dev/null 2>&1; then
    log "Running ntn doctor"
    ntn doctor || log "WARN ntn doctor reported issues"
  fi
}

log "Forge runner starting mode=${MODE} debug=${DEBUG_MODE} ci_env=${CI_ENV}"
ensure_env_file

if [ "$CI_ENV" = "1" ]; then
  export_ci_stub_env
fi

check_node
check_pnpm

case "$MODE" in
  setup)
    install_dependencies
    ;;
  doctor)
    run_doctor
    ;;
  verify-env)
    install_dependencies
    verify_env
    ;;
  lint)
    install_dependencies
    verify_env
    pnpm lint -- --max-warnings=0
    ;;
  typecheck)
    install_dependencies
    verify_env
    pnpm typecheck
    ;;
  test)
    install_dependencies
    verify_env
    pnpm test
    ;;
  build)
    install_dependencies
    verify_env
    pnpm build
    ;;
  check)
    install_dependencies
    verify_env
    log "Running lint"
    pnpm lint -- --max-warnings=0
    log "Running typecheck"
    pnpm typecheck
    log "Running tests"
    pnpm test
    log "Running build"
    pnpm build
    ;;
  dev)
    install_dependencies
    verify_env
    log "Starting dev server at http://localhost:3000"
    pnpm dev
    ;;
esac
