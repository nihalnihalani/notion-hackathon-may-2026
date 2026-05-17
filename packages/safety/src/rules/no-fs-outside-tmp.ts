import type { TSESTree } from '@typescript-eslint/utils';
import type { Rule, Violation } from '../types.js';
import { walk, memberPath, makeViolation, staticStringArg } from '../ast-utils.js';

const RULE = 'no-fs-outside-tmp';

/**
 * fs methods that read or mutate a path. We treat reads as block too because
 * a "read /etc/passwd and exfiltrate" attack is just as bad as a write.
 */
const FS_METHODS = new Set([
  'writeFile',
  'writeFileSync',
  'readFile',
  'readFileSync',
  'appendFile',
  'appendFileSync',
  'unlink',
  'unlinkSync',
  'rmdir',
  'rmdirSync',
  'rm',
  'rmSync',
  'mkdir',
  'mkdirSync',
  'createReadStream',
  'createWriteStream',
  'open',
  'openSync',
  'copyFile',
  'copyFileSync',
]);

/**
 * Recognized `fs` roots. We deliberately do NOT match `import * as fs from
 * 'fs'` with renames (`import * as foo from 'fs'`) — those exist but are
 * exotic enough that we accept the false-negative in favor of low complexity.
 */
const FS_ROOTS = new Set(['fs', 'fsp', 'fsPromises']);

/** Path is acceptable if it starts with `/tmp/` (Worker scratch) or is relative. */
function isAcceptablePath(path: string): boolean {
  if (path === '/tmp' || path.startsWith('/tmp/')) return true;
  if (path === './tmp' || path.startsWith('./tmp/')) return true;
  // Relative paths (./foo, ../foo, foo/bar) — Workers chroot semantics treat
  // these as scratch-dir-relative per PLAN.md §IX.
  if (path.startsWith('./') || path.startsWith('../')) return true;
  if (!path.startsWith('/') && !path.includes('://')) return true;
  return false;
}

/**
 * Block file writes / reads outside `/tmp` (string-literal paths only).
 *
 * Dynamic paths are handled separately by no-non-allowlisted-network's
 * sibling rule (TODO: add no-dynamic-fs-path if Devil's Advocate insists).
 * For now we report dynamic paths as `warn` so the human can investigate.
 */
export const noFsOutsideTmp: Rule = {
  name: RULE,
  check(ast: TSESTree.Program, source: string): Violation[] {
    const violations: Violation[] = [];

    walk(ast, (node) => {
      if (node.type !== 'CallExpression') return;
      if (node.callee.type !== 'MemberExpression') return;

      const path = memberPath(node.callee);
      if (!path) return;

      const segments = path.split('.');
      const root = segments[0];
      const method = segments[segments.length - 1];
      if (root === undefined || method === undefined) return;
      if (!FS_ROOTS.has(root)) return;
      if (!FS_METHODS.has(method)) return;

      const firstArg = node.arguments[0];
      const literal = staticStringArg(firstArg);

      if (literal === null) {
        // Dynamic path — surface a warning. Worker code SHOULD use literal
        // /tmp paths; anything else is suspicious enough to flag.
        if (firstArg) {
          violations.push(
            makeViolation({
              rule: RULE,
              severity: 'warn',
              message: `Dynamic path passed to ${path}() — must be statically /tmp-prefixed`,
              node,
              source,
            }),
          );
        }
        return;
      }

      if (!isAcceptablePath(literal)) {
        violations.push(
          makeViolation({
            rule: RULE,
            severity: 'block',
            message: `${path}() targets path '${literal}' outside /tmp`,
            node,
            source,
          }),
        );
      }
    });

    return violations;
  },
};
