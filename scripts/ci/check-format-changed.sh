#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "--" ]; then
  shift
fi

base_sha="${1:-}"
head_sha="${2:-HEAD}"

if [ -z "${base_sha}" ]; then
  if [ -n "${GITHUB_BASE_REF:-}" ] && git rev-parse --verify "origin/${GITHUB_BASE_REF}^{commit}" >/dev/null 2>&1; then
    base_sha="$(git merge-base "${head_sha}" "origin/${GITHUB_BASE_REF}")"
  else
    base_sha="$(git rev-parse "${head_sha}^" 2>/dev/null || true)"
  fi
fi

if printf '%s' "${base_sha}" | grep -Eq '^0+$'; then
  base_sha="$(git rev-list --max-parents=0 "${head_sha}" | tail -n 1)"
fi

if [ -z "${base_sha}" ] || ! git rev-parse --verify "${base_sha}^{commit}" >/dev/null 2>&1; then
  echo "::error::Could not resolve a base commit for changed-file format check."
  echo "base='${base_sha}' head='${head_sha}'"
  exit 1
fi

if ! git rev-parse --verify "${head_sha}^{commit}" >/dev/null 2>&1; then
  echo "::error::Could not resolve head commit '${head_sha}' for changed-file format check."
  exit 1
fi

tmp_file="$(mktemp)"
trap 'rm -f "${tmp_file}"' EXIT

git diff --name-only -z --diff-filter=ACMR "${base_sha}" "${head_sha}" -- \
  '*.ts' \
  '*.tsx' \
  '*.js' \
  '*.jsx' \
  '*.json' \
  '*.md' \
  '*.mjs' \
  '*.yml' \
  '*.yaml' \
  ':!pnpm-lock.yaml' \
  >"${tmp_file}"

if [ ! -s "${tmp_file}" ]; then
  echo "No changed Prettier-managed files."
  exit 0
fi

file_count="$(tr -cd '\0' <"${tmp_file}" | wc -c | tr -d ' ')"
echo "Checking Prettier on ${file_count} changed file(s):"
tr '\0' '\n' <"${tmp_file}" | sed 's/^/  - /'

xargs -0 pnpm exec prettier --check <"${tmp_file}"
