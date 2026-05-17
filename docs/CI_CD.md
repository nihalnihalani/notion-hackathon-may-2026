# Forge CI/CD

This document is the source of truth for everything that happens after `git push`.

## Workflow map

| Workflow                                        | Trigger                         | Purpose                                                                                                                            |
| ----------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                      | PR + push to `main`, manual     | Lint / changed-file format / typecheck / verify-env / prisma-check / test / safety coverage / evals-dry / build.                   |
| `.github/workflows/deploy-preview.yml`          | PR to `main`                    | CI-equivalent verify only; no optional provider jobs appear as skipped PR checks.                                                  |
| `.github/workflows/deploy-preview-external.yml` | manual dispatch                 | Maintainer-run PlanetScale preview branch → Vercel preview deploy → sticky PR comment → optional E2E after provider secrets exist. |
| `.github/workflows/deploy-prod.yml`             | push to `main`, manual dispatch | Release-candidate verify → build → prisma migrate deploy → Vercel prod → Sentry release → healthz smoke → optional Slack / issue.  |
| `.github/workflows/evals-nightly.yml`           | cron `0 3 * * *`, manual        | Real-API Promptfoo sweep → baseline diff → HTML report on Pages → Slack on regression.                                             |
| `.github/workflows/security.yml`                | PR + push + Monday 09:00 UTC    | `pnpm audit` (high+critical) plus Gitleaks committed-secret scanning.                                                              |
| `.github/dependabot.yml`                        | weekly Monday                   | npm + github-actions updates, grouped.                                                                                             |

## Required GitHub secrets

Set in **Repository Settings → Secrets and variables → Actions**.

| Secret                         | Used by              | Notes                                                                            |
| ------------------------------ | -------------------- | -------------------------------------------------------------------------------- |
| `VERCEL_TOKEN`                 | preview, prod        | Personal/service token with deploy scope on the Forge project.                   |
| `VERCEL_ORG_ID`                | preview, prod        | From `.vercel/project.json` after `vercel link`.                                 |
| `VERCEL_PROJECT_ID`            | preview, prod        | Same source as above.                                                            |
| `PLANETSCALE_SERVICE_TOKEN`    | preview              | Service token value (the secret part).                                           |
| `PLANETSCALE_SERVICE_TOKEN_ID` | preview              | Service token id.                                                                |
| `PLANETSCALE_ORG`              | preview              | Org slug, e.g. `forge`.                                                          |
| `PLANETSCALE_DB`               | preview              | Database name, e.g. `forge-prod`.                                                |
| `DATABASE_URL`                 | prod                 | PlanetScale prod connection string used by `prisma migrate deploy`.              |
| `SENTRY_AUTH_TOKEN`            | prod                 | Sentry token with `project:releases` scope.                                      |
| `SENTRY_ORG`                   | prod                 | Sentry org slug.                                                                 |
| `SENTRY_PROJECT`               | prod                 | Sentry project slug.                                                             |
| `SLACK_WEBHOOK_URL`            | prod, evals-nightly  | Incoming-webhook URL for `#forge-deploys` (prod) / `#forge-evals` (regressions). |
| `ANTHROPIC_API_KEY`            | evals-nightly        | Real Anthropic key. Never used by per-PR CI.                                     |
| `OPENAI_API_KEY`               | evals-nightly        | Real OpenAI key. Never used by per-PR CI.                                        |
| `OPENAI_ORG_ID`                | evals-nightly        | Optional OpenAI org id.                                                          |
| `CODECOV_TOKEN`                | ci (safety coverage) | Optional Codecov project upload token. Upload failures do not fail CI.           |

Per-PR CI uses **only** the stub env values inlined in `ci.yml` / `deploy-preview.yml`. No real API key is ever exposed to PR-triggered verification runs.

`deploy-preview.yml` always runs verification and deliberately does not create optional PlanetScale, Vercel, sticky-comment, or E2E jobs. That keeps the PR check list clean while the repository is still missing deploy-provider credentials. Once the preview provider secrets are configured, maintainers can run `deploy-preview-external.yml` manually for a PR.

All Node-based jobs install through `scripts/ci/install.sh`, which runs `pnpm install --frozen-lockfile` and then generates the Prisma Client for `@forge/db`. Use that script instead of a raw `pnpm install` step in new workflows so fresh GitHub runners match local builds.

Workflows use Node-24-compatible action majors and set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` so GitHub-hosted runners exercise the upcoming action runtime now, while the project itself continues to build and test on `NODE_VERSION=20`.

The repository is currently private, so CodeQL is not part of the automatic PR security workflow until GitHub Advanced Security/code scanning is enabled. `ci.yml` intentionally checks Prettier only on changed files because the current tree still has historical formatting drift outside this branch; use a dedicated repo-wide formatting PR when you want to flip `pnpm format:check` back on globally.

## How to add a new sub-agent eval

1. Drop a new YAML at `packages/eval-harness/evals/<agent>.yaml` following the existing four configs.
2. Add the agent name to `AGENT_NAMES` in `packages/eval-harness/src/agents.ts`.
3. Add a baseline entry to `packages/eval-harness/evals/baselines.json`:
   ```json
   "<agent>": { "passRate": null, "totalCases": <n> }
   ```
4. Update the per-agent minimum-case map in `packages/eval-harness/src/runner.test.ts`.
5. Run `pnpm --filter @forge/eval-harness eval:dry-run` locally — should print all agents with positive case counts.
6. After the first green nightly run, run `pnpm --filter @forge/eval-harness baseline:update` to seed the baseline.

## Triggering manual deploys

### Re-run the latest prod deploy

```
gh workflow run deploy-prod.yml --ref main
```

### Deploy a PR preview after provider secrets are configured

```
gh workflow run deploy-preview-external.yml --ref <pr-branch> -f pr_number=<number> -f run_e2e=false
```

### Hotfix that doesn't change the schema

```
gh workflow run deploy-prod.yml --ref main -f skip_migrations=true
```

### Force a nightly eval with a custom regression threshold

```
gh workflow run evals-nightly.yml -f regression_threshold_pct=10
```

### Cut a release tag

```
./scripts/release.sh patch     # 0.1.0 → 0.1.1
./scripts/release.sh minor     # 0.1.0 → 0.2.0
./scripts/release.sh major     # 0.1.0 → 1.0.0
```

The script bumps `package.json`, commits, tags `vX.Y.Z`, and pushes both branch + tag.

## Rollback procedure

Rollbacks are **manual** because the most common deploy failure is a bad migration, and reverting the merge without also rolling the schema back can corrupt production data.

### Decision tree

1. **Read the auto-opened deploy-failure issue.** `deploy-prod.yml` opens a `p0` issue listing every failed job and a link to the run.
2. **App-only regression (no schema change):**
   1. In Vercel dashboard → Deployments → click the previous green prod deployment → **Promote to Production**.
   2. Revert the offending merge commit on `main`: `git revert <sha> && git push`.
3. **Schema-related failure:**
   1. **Do not** promote the previous Vercel deploy before reverting the schema — the old code will hit incompatible columns.
   2. PlanetScale: revert the deploy request from the PlanetScale UI, or `pscale deploy-request revert <db> <number>`.
   3. Once the schema is back, revert the merge commit and let prod redeploy naturally.
4. **Sentry-only failure (smoke + Vercel green):**
   1. Leave production in place. Sentry source-map upload is not gating.
   2. Re-run the Sentry release job: `gh run rerun <run-id> --job sentry-release`.

### Verifying after rollback

```
curl -sS https://forge.example.com/api/healthz | jq .
```

Expect `{ "status": "ok", ... }`. If `status` ≠ `ok`, page the on-call channel.

## Concurrency rules at a glance

| Workflow                  | Concurrency group                     | Cancel in-progress?                                  |
| ------------------------- | ------------------------------------- | ---------------------------------------------------- |
| `ci.yml`                  | `ci-<workflow>-<ref>`                 | yes (newer commit wins)                              |
| `deploy-preview`          | `deploy-preview-<pr-number>`          | yes (newer PR commit wins)                           |
| `deploy-preview-external` | `deploy-preview-external-<pr-number>` | yes (newer manual run wins)                          |
| `deploy-prod`             | `deploy-prod` (single global)         | yes (newer main commit wins; we never want two prod) |
| `evals-nightly`           | `evals-nightly` (single global)       | no (let nightly runs complete before next)           |
| `security`                | `security-<workflow>-<ref>`           | yes                                                  |

## Pinned action versions

All third-party actions are pinned to a major version. Dependabot bumps them weekly. To pin to a SHA instead (recommended once the team has bandwidth to vet diffs):

```
- uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
```
