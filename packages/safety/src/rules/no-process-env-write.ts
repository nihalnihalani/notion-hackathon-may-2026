import type { TSESTree } from '@typescript-eslint/utils';
import type { Rule, Violation } from '../types.js';
import { walk, memberPath, makeViolation } from '../ast-utils.js';

const RULE = 'no-process-env-write';

/**
 * Test whether a node is `process.env` itself (the object).
 */
function isExactlyProcessEnv(node: TSESTree.Node): boolean {
  if (node.type !== 'MemberExpression') return false;
  if (node.computed) return false;
  if (node.property.type !== 'Identifier' || node.property.name !== 'env') return false;
  return node.object.type === 'Identifier' && node.object.name === 'process';
}

/**
 * Test whether a node is `process.env` (or `process.env.FOO` / `process.env['FOO']`,
 * in which case the WRITE target is the FOO property — same warning applies).
 *
 * Handles both dotted (`process.env.X`) and computed (`process.env['X']`) forms.
 */
function isProcessEnvAccess(node: TSESTree.Node): boolean {
  if (node.type !== 'MemberExpression') return false;
  // process.env itself
  if (isExactlyProcessEnv(node)) return true;
  // process.env.X (dotted)
  const path = memberPath(node);
  if (path && (path === 'process.env' || path.startsWith('process.env.'))) {
    return true;
  }
  // process.env['X'] / process.env[someVar] — computed access whose OBJECT is process.env
  if (isExactlyProcessEnv(node.object)) return true;
  return false;
}

/**
 * Warn on mutations to `process.env`.
 *
 * Severity is `warn` not `block` because some legitimate Tool Coder output
 * may need to set per-call env to drive deps. But it's suspicious — env
 * leaks are an easy data-exfil vector — so we always surface.
 */
export const noProcessEnvWrite: Rule = {
  name: RULE,
  check(ast: TSESTree.Program, source: string): Violation[] {
    const violations: Violation[] = [];

    walk(ast, (node) => {
      // process.env.FOO = ... / process.env['FOO'] = ...
      if (node.type === 'AssignmentExpression') {
        const left = node.left;
        if (left.type === 'MemberExpression' && isProcessEnvAccess(left)) {
          violations.push(
            makeViolation({
              rule: RULE,
              severity: 'warn',
              message: 'Assignment to process.env is suspicious in Worker code',
              node,
              source,
            }),
          );
          return;
        }
        // process.env = { ... }
        if (isProcessEnvAccess(left)) {
          violations.push(
            makeViolation({
              rule: RULE,
              severity: 'warn',
              message: 'Replacement of process.env is suspicious in Worker code',
              node,
              source,
            }),
          );
        }
      }

      // delete process.env.FOO
      if (
        node.type === 'UnaryExpression' &&
        node.operator === 'delete' &&
        isProcessEnvAccess(node.argument)
      ) {
        violations.push(
          makeViolation({
            rule: RULE,
            severity: 'warn',
            message: 'delete of process.env key is suspicious in Worker code',
            node,
            source,
          }),
        );
      }

      // Object.assign(process.env, ...)
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'MemberExpression' &&
        memberPath(node.callee) === 'Object.assign'
      ) {
        const target = node.arguments[0];
        if (target && isProcessEnvAccess(target)) {
          violations.push(
            makeViolation({
              rule: RULE,
              severity: 'warn',
              message: 'Object.assign(process.env, ...) is suspicious in Worker code',
              node,
              source,
            }),
          );
        }
      }
    });

    return violations;
  },
};
