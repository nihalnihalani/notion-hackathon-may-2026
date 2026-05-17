/**
 * @forge/safety — AST scanner for generated Worker code.
 *
 * Public API:
 *   - scan(source, opts)        — scan an in-memory TS string
 *   - scanFile(path, opts)      — read file then scan
 *   - scanPackageJson(obj, opts)— check package.json dep allowlist
 *   - ALL_RULES                 — the rules registry (for introspection / docs)
 *   - DEFAULT_NETWORK_ALLOWLIST / DEFAULT_DEP_ALLOWLIST
 *
 * See PLAN.md §IX for the security spec this implements.
 */
export { scan, scanFile, scanPackageJson } from './scanner.js';
export type {
  Severity,
  Violation,
  ScanOptions,
  ScanResult,
  Rule,
} from './types.js';
export { ScannerParseError } from './types.js';
export {
  DEFAULT_NETWORK_ALLOWLIST,
  DEFAULT_DEP_ALLOWLIST,
} from './allowlists.js';
export { ALL_RULES } from './rules/index.js';
export {
  noChildProcess,
  noFsOutsideTmp,
  noEval,
  noNonAllowlistedNetwork,
  noProcessEnvWrite,
  noUnboundedLoops,
  depAllowlist,
  checkPackageJson,
} from './rules/index.js';
