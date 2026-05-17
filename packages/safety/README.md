# @forge/safety

The code-gen safety net. AST-walks every generated TypeScript file against a forbidden-API list (no `eval`, no `child_process`, no raw network beyond approved connectors, no `fs` writes outside the worker's scratch dir), validates `j` schemas against a strict reference, and enforces secret-handling rules so secrets never appear in source.

## Public API surface

- `scan(source, opts)` — scan an in-memory TypeScript worker source string.
- `scanFile(path, opts)` — read and scan a TypeScript file.
- `scanPackageJson(obj, opts)` — enforce dependency allowlists on generated
  package metadata.
- `DEFAULT_NETWORK_ALLOWLIST` and `DEFAULT_DEP_ALLOWLIST` — production
  allowlist defaults shared by Inspector and tests.
- `ALL_RULES` — registry of scanner rules for introspection.
- Individual rules: `noChildProcess`, `noFsOutsideTmp`, `noEval`,
  `noNonAllowlistedNetwork`, `noProcessEnvWrite`, `noUnboundedLoops`,
  `depAllowlist`, and `checkPackageJson`.
- Types: `ScanOptions`, `ScanResult`, `Violation`, `Rule`, `Severity`, and
  `ScannerParseError`.
