# Contributing to Forge

Thanks for your interest. Forge is MIT-licensed and we welcome external contributions. Please read this end-to-end before opening a PR.

> All contributors must follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues — see [`SECURITY.md`](SECURITY.md), do **not** open a public issue.

---

## Dev environment

### Prerequisites

- Node.js **20+** (`nvm use` picks up `.nvmrc`)
- pnpm **9+** (`corepack enable && corepack prepare pnpm@9 --activate`)
- Notion `ntn` CLI (`curl -fsSL https://ntn.dev | bash`)
- A Notion workspace with the Developer Platform enabled

### One-time setup

```bash
git clone https://github.com/nihalnihalani/forge.git
cd forge
bash scripts/setup.sh    # verifies versions, copies .env.example → .env, installs deps, runs `ntn doctor`
```

Fill in `.env`, then:

```bash
pnpm verify:env
pnpm dev
```

The Next.js dashboard listens on `http://localhost:3000`.

### Running the test suite

```bash
pnpm typecheck          # turbo run typecheck — all packages
pnpm lint               # turbo run lint
pnpm test               # turbo run test (vitest)
pnpm test:coverage      # vitest with coverage report
pnpm format:check       # prettier --check
```

For a single package: `pnpm --filter @forge/<pkg> test`.

For Playwright E2E:

```bash
pnpm --filter @forge/web e2e
```

---

## Branch naming

Use kebab-case, scoped by intent:

| Prefix | When |
|---|---|
| `feat/<short-name>` | New user-facing capability |
| `fix/<short-name>` | Bug fix |
| `refactor/<short-name>` | Internal change, no behavior delta |
| `docs/<short-name>` | Docs-only change |
| `chore/<short-name>` | Deps, tooling, CI, formatting |
| `test/<short-name>` | New or changed tests only |
| `perf/<short-name>` | Performance-only change |

Examples: `feat/inspector-retry-loop`, `fix/ntn-wrapper-timeout-leak`, `docs/architecture-diagram`.

---

## Commit message format

[Conventional Commits](https://www.conventionalcommits.org/) with the type drawn from the table above:

```
<type>(<scope>): <subject>

<body — optional, wrap at 72 cols>

<footer — optional: Refs: #123, Closes: #456, BREAKING CHANGE: …>
```

- `<scope>` is the package name without the `@forge/` prefix, or `web` for the app, or `repo` for cross-cutting.
- Subject is imperative, lower-case, no trailing period: `add prompt cache lookup`, not `Added prompt cache lookup.`

Examples:

```
feat(agents): add Tool Coder AST retry loop
fix(ntn-wrapper): release stdin handle on SIGTERM
docs(repo): tighten README quickstart for non-Mac dev envs
```

---

## PR process

1. Open the PR against `main`. Draft PRs are fine — flip to ready when CI is green.
2. **All of these must pass** before review:
   - `pnpm typecheck` — strict TS, no `any`, no `@ts-ignore` without a comment justifying it
   - `pnpm lint` — ESLint (flat config in `eslint.config.mjs`)
   - `pnpm test` — vitest, coverage ≥80% on `packages/agents`, `packages/ntn-wrapper`, `packages/safety`
   - `pnpm format:check` — prettier
   - For schema changes: `pnpm --filter @forge/db db:migrate` clean diff and `prisma migrate diff` reviewed
3. Vercel posts a preview deploy comment on every PR — open it and sanity-check.
4. PR description must include:
   - **What & why** (1–3 sentences)
   - **How to test** (commands or click-through)
   - **Risk/blast radius** (one of: contained, package-local, cross-package, schema-changing, security-relevant)
   - **Linked issue** (`Closes #N`) if applicable
5. Squash-merge is the default. Keep the squashed subject line conventional.

Reviewers will ask for changes via [Conventional Comments](https://conventionalcomments.org/) (`nit:`, `suggestion:`, `issue:`, `praise:`, `question:`). Reply or push fixups; don't force-push after the first review unless asked.

---

## How to add a new agent pattern

Forge ships **five** supported tool patterns (see [`PLAN.md` §4.1](PLAN.md#41-schema-smith)). Adding a sixth is a coordinated change across four packages.

1. **Define the pattern** — add the enum to `AgentPattern` in `packages/db/prisma/schema.prisma`. Run `pnpm --filter @forge/db db:migrate` to generate a migration; commit it.
2. **Schema Smith** — extend the system prompt in `packages/agents/src/schema-smith.ts` so the model knows when to choose the new pattern. Add the pattern to the Zod `pattern` union and update the validation tests.
3. **Tool Coder** — add a few-shot example in `packages/agents/src/tool-coder/few-shots/<pattern>.ts` showing the canonical TS shape. Add it to the cached prompt prefix so it benefits from prompt caching from request #1.
4. **Inspector** — author at least one synthetic input shape for the new pattern in `packages/agents/src/inspector/synthetic-inputs.ts` so `ntn workers exec` has something realistic to run.
5. **Safety** — if the pattern requires net-new APIs, add them to `packages/safety/src/allowed-apis.ts`. Be conservative — every new entry expands the trust surface.
6. **Eval harness** — add ≥3 golden inputs to `packages/eval-harness/evals/schema-smith.yaml` covering happy + edge + ambiguity for the new pattern, plus matching entries in `tool-coder.yaml`. Run `pnpm --filter @forge/eval-harness eval:dry-run` locally and `eval` against real APIs if you have keys.
7. **Docs** — update the "What it does" table in `README.md` and the pattern list in `PLAN.md` §4.1.

PR title: `feat(agents): add <pattern-name> pattern`.

---

## How to add a new connector

Connectors live in `packages/connectors/src/<provider>/` and follow the factory pattern (see [`packages/connectors/README.md`](packages/connectors/README.md) — `createXClient(config)`).

1. **Create the directory** `packages/connectors/src/<provider>/`:
   - `index.ts` — exports `create<Provider>Client(config)` only.
   - `client.ts` — the typed methods. Use the shared `fetchWithRetry` helper (3 retries, exponential backoff + jitter, 429 + 5xx retryable, 401/403/404/422 immediate throw).
   - `schemas.ts` — Zod schemas for inputs + responses. Export `z.infer` types.
   - `errors.ts` — extends `ConnectorError` with provider-specific subclasses.
   - `client.test.ts` — vitest, mock `fetch` directly (no MSW), cover happy + each error class.
2. **Wire it into the barrel exports** in `packages/connectors/src/index.ts`. Add the row to the connector inventory in `packages/connectors/README.md`.
3. **Add a Tool Coder few-shot** in `packages/agents/src/tool-coder/few-shots/connectors/<provider>.ts` showing the connector being used inside a generated Worker. This is what makes Tool Coder learn to use the new connector.
4. **OAuth?** If the provider needs OAuth, add it to the `ProviderName` enum in `packages/agents/src/types.ts` and document the `ntn oauth start <provider>` flow in [`PLAN.md` Part XI](PLAN.md#part-xi--integrations-catalog).
5. **Add a sample agent** to `packages/eval-harness/evals/tool-coder.yaml` that uses the connector.

PR title: `feat(connectors): add <provider>`.

### Non-negotiables for connectors

- No module-level state. No reading `process.env` inside `packages/connectors`. Config is passed to the factory.
- ESM only, native `fetch`, Edge-compatible (no `node:` imports unless the connector is explicitly Node-only and clearly marked).
- Validation is opt-in per call via `{ validate: true }` — default is off.
- All errors throw as typed subclasses of `ConnectorError`.

---

## Reporting bugs

Open a GitHub issue using the bug template. Include:

- Repro steps (commands or click-through)
- Expected vs actual
- Output of `ntn doctor` and Node + pnpm versions
- Relevant log snippets (redact secrets)

For security issues, see [`SECURITY.md`](SECURITY.md).

---

## Acknowledgments

This guide takes heavy inspiration from the [Vercel Next.js contributing guide](https://github.com/vercel/next.js/blob/canary/contributing.md) and the [Prisma contributing guide](https://github.com/prisma/prisma/blob/main/CONTRIBUTING.md). Thanks to both teams for setting the bar.
