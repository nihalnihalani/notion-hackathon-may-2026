import type { Rule, Violation, ScanOptions } from '../types.js';

const RULE = 'dep-allowlist';

/**
 * `scanPackageJson` rule. Unlike the AST rules, this one operates on a
 * parsed object — there's nothing to walk. We expose it as a Rule for
 * symmetry, but it ignores `ast` / `source`.
 *
 * Block ANY dependency or devDependency that is not on the allowlist.
 *
 * peerDependencies and optionalDependencies are NOT checked here because
 * generated Worker code shouldn't declare them; the Inspector should
 * separately reject any package.json with those keys (responsibility of
 * the schema validator in PLAN.md §IX, not this rule).
 */
export const depAllowlist: Rule = {
  name: RULE,
  // The AST `check` is a no-op — package.json scanning uses the dedicated
  // exported function below. We keep this stub so ALL_RULES stays uniform
  // and callers that try to run it against source get a clean "no violations".
  check(): Violation[] {
    return [];
  },
};

/**
 * Pure function variant — called by scanner.scanPackageJson.
 *
 * `packageJson` is the already-parsed object. Caller is responsible for
 * having parsed it without crashing (we don't want try/catch around JSON
 * parsing to silently swallow malformed package.json — that's a separate
 * failure surface).
 */
export function checkPackageJson(
  packageJson: object,
  opts: ScanOptions,
): Violation[] {
  const violations: Violation[] = [];
  const allowSet = new Set(opts.depAllowlist);

  for (const key of ['dependencies', 'devDependencies'] as const) {
    const block = (packageJson as Record<string, unknown>)[key];
    if (!block || typeof block !== 'object') continue;
    for (const dep of Object.keys(block as Record<string, unknown>)) {
      if (!allowSet.has(dep)) {
        violations.push({
          rule: RULE,
          severity: 'block',
          message: `Dependency '${dep}' (in ${key}) is not on the allowlist`,
          line: 0,
          column: 0,
          snippet: `"${dep}"`,
        });
      }
    }
  }

  return violations;
}
