# @forge/ntn-wrapper

Typed, audit-logged wrapper around the `ntn` CLI. Covers `workers` (new/deploy/exec/list/get/delete/env/capabilities/runs/sync), `oauth` (start/token/show-redirect-url), `pages` (create/update/trash/get), `webhooks` (list), `datasources` (query/resolve), `files` (create/get/list), `doctor`, and a generic `api` escape hatch. Every call goes through a single `runNtn` primitive that streams stdout/stderr, parses structured output, and surfaces non-zero exits as typed errors.

## Design contract

- **Production-only.** No demo paths, no mocks, no env-sniffing inside library code. The caller passes `cwd`, `env`, `timeoutMs`, `signal`, and `logger` via `NtnRunOptions`.
- **ESM, TS strict.** Builds against the workspace `tsconfig.base.json` (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- **Typed errors only.** Every failure mode is `NtnError` or a subclass: `NtnNotInstalledError`, `NtnTimeoutError`, `NtnExecError`, `NtnJsonParseError`, `NtnAuthError`, `NtnInvalidArgumentError`.
- **Real subprocess calls.** Uses `node:child_process.spawn` for every invocation — capped stdout/stderr buffers, SIGTERM-then-SIGKILL timeout, `AbortSignal` cancellation.
- **No `console.log`.** Optional `NtnLogger` interface; default is silent.

## Public surface

```ts
import {
  // Low-level
  runNtn, runNtnJson,
  // Workers
  scaffoldWorker, deployWorker, execWorker, listWorkers, getWorker, deleteWorker,
  listCapabilities, setEnv, listEnv, unsetEnv, pullEnv, pushEnv,
  // Sync
  triggerSync, pauseSync, resumeSync, getSyncState, resetSyncState,
  // Runs
  listRuns, getRunLogs,
  // OAuth
  startProviderOAuth, getProviderToken, getProviderRedirectUrl,
  // Pages / webhooks / datasources / files
  getPage, createPage, updatePage, trashPage,
  listWebhooks,
  queryDatasource, resolveDatasource,
  createFile, getFile, listFiles,
  // Generic + diagnostics
  callNotionApi,
  runDoctor, runDoctorRaw,
  isLoggedIn, loginInstructions,
  // Errors
  NtnError, NtnNotInstalledError, NtnTimeoutError, NtnExecError,
  NtnJsonParseError, NtnAuthError, NtnInvalidArgumentError,
} from '@forge/ntn-wrapper';
```

See `src/index.ts` for the complete export list.

## Usage example

```ts
import { deployWorker, NtnAuthError, NtnTimeoutError } from '@forge/ntn-wrapper';

try {
  const result = await deployWorker('linear-bug-triager', {
    cwd: '/tmp/forge/gen_abc/worker',
    timeoutMs: 120_000,
    env: { ...process.env, NTN_HOME: '/tmp/forge/gen_abc/.ntn' },
    signal: abortController.signal,
    logger: structuredLogger,
  });
  console.log(`deployed → ${result.deployUrl ?? 'unknown'}`);
} catch (err) {
  if (err instanceof NtnAuthError) { /* prompt re-login */ }
  if (err instanceof NtnTimeoutError) { /* retry or surface */ }
  throw err;
}
```

## Testing

```sh
pnpm --filter @forge/ntn-wrapper test
```

Tests use `process.execPath` as a fake `ntn` binary (Node running inline scripts) so they are hermetic and do not require the real CLI.
