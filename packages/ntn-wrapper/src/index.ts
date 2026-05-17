/**
 * @forge/ntn-wrapper — typed, production-grade wrapper around the `ntn` CLI.
 *
 * Public entry point. Named exports only (no `export *`) so the surface is
 * explicit and tree-shaking has no ambiguity. Callers should always import
 * from `@forge/ntn-wrapper`, never reach into individual modules.
 */

// ---------------- Types ----------------
export type {
  DatabaseId,
  DeployResult,
  DoctorReport,
  FileId,
  NtnLogger,
  NtnRunOptions,
  NtnRunResult,
  OAuthProvider,
  PageId,
  RunId,
  SyncState,
  WebhookEndpoint,
  Worker,
  WorkerCapability,
  WorkerName,
  WorkerRun,
} from './types';

// ---------------- Errors ----------------
export {
  NtnAuthError,
  NtnError,
  NtnExecError,
  NtnInvalidArgumentError,
  NtnJsonParseError,
  NtnNotInstalledError,
  NtnTimeoutError,
} from './errors';

// ---------------- Low-level exec primitives ----------------
export { runNtn, runNtnJson } from './exec';

// ---------------- Parsers (exposed for advanced callers / tests) ----------------
export {
  extractDeployUrl,
  extractWorkerId,
  findJsonSlice,
  looksLikeAuthFailure,
  parseNtnJson,
} from './parsers';

// ---------------- Workers ----------------
export {
  deleteWorker,
  deployWorker,
  execWorker,
  getWorker,
  listCapabilities,
  listEnv,
  listWorkers,
  pullEnv,
  pushEnv,
  scaffoldWorker,
  setEnv,
  unsetEnv,
} from './workers';

// ---------------- Sync ----------------
export {
  getSyncState,
  pauseSync,
  resetSyncState,
  resumeSync,
  triggerSync,
} from './sync';

// ---------------- Runs ----------------
export { getRunLogs, listRuns } from './runs';

// ---------------- OAuth ----------------
export {
  getProviderRedirectUrl,
  getProviderToken,
  startProviderOAuth,
} from './oauth';

// ---------------- Pages ----------------
export {
  createPage,
  createPageMarkdown,
  getPage,
  trashPage,
  updatePage,
  updatePageMarkdown,
} from './pages';
export type { PageParent } from './pages';

// ---------------- Comments ----------------
export { createComment, type CreateCommentInput } from './comments';

// ---------------- Webhooks ----------------
export { listWebhooks } from './webhooks';

// ---------------- Datasources ----------------
export { queryDatasource, resolveDatasource } from './datasources';

// ---------------- Files ----------------
export { createFile, getFile, listFiles, runFilesCommand } from './files';

// ---------------- Generic API escape hatch ----------------
export {
  callNotionApi,
  getApiEndpointDocs,
  getApiEndpointHelp,
  getApiEndpointSpec,
  listApiEndpoints,
  type CallNotionApiOptions,
} from './api';

// ---------------- Doctor & auth ----------------
export { runDoctor, runDoctorRaw } from './doctor';
export { hasApiToken, isLoggedIn, loginInstructions } from './auth';
