import type { TSESTree } from '@typescript-eslint/utils';
import type { Rule, Violation } from '../types.js';
import { walk, memberPath, makeViolation } from '../ast-utils.js';

const RULE = 'no-child-process';

const FORBIDDEN_MODULES = new Set([
  'child_process',
  'node:child_process',
]);

/**
 * Method paths under `process` that spawn subprocesses. `process.kill` is
 * NOT here on purpose — workers may need to no-op signal handling in test.
 */
const FORBIDDEN_PROCESS_METHODS = new Set([
  'process.exec',
  'process.execSync',
  'process.spawn',
  'process.spawnSync',
  'process.execFile',
  'process.execFileSync',
  'process.fork',
]);

/**
 * Blocks anything that lets the generated Worker shell out.
 *
 * Notion Workers run in a managed runtime; `child_process` should be
 * structurally unavailable, but a determined prompt-injection payload could
 * try to require it dynamically. We block at the AST level so the failure
 * mode is "can't deploy" rather than "deploys and silently fails at runtime".
 */
export const noChildProcess: Rule = {
  name: RULE,
  check(ast: TSESTree.Program, source: string): Violation[] {
    const violations: Violation[] = [];

    walk(ast, (node) => {
      // 1. Static imports
      if (node.type === 'ImportDeclaration') {
        if (
          typeof node.source.value === 'string' &&
          FORBIDDEN_MODULES.has(node.source.value)
        ) {
          violations.push(
            makeViolation({
              rule: RULE,
              severity: 'block',
              message: `Import of forbidden module '${node.source.value}'`,
              node,
              source,
            }),
          );
        }
      }

      // 2. CJS-style require('child_process') — generated code shouldn't use
      // CJS, but bias strict.
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        node.arguments.length >= 1
      ) {
        const arg = node.arguments[0];
        if (
          arg &&
          arg.type === 'Literal' &&
          typeof arg.value === 'string' &&
          FORBIDDEN_MODULES.has(arg.value)
        ) {
          violations.push(
            makeViolation({
              rule: RULE,
              severity: 'block',
              message: `require() of forbidden module '${arg.value}'`,
              node,
              source,
            }),
          );
        }
      }

      // 3. Dynamic import('child_process')
      if (node.type === 'ImportExpression') {
        const arg = node.source;
        if (
          arg.type === 'Literal' &&
          typeof arg.value === 'string' &&
          FORBIDDEN_MODULES.has(arg.value)
        ) {
          violations.push(
            makeViolation({
              rule: RULE,
              severity: 'block',
              message: `Dynamic import of forbidden module '${arg.value}'`,
              node,
              source,
            }),
          );
        }
      }

      // 4. process.exec / process.spawn / etc. — even if process never
      // actually has these in the Workers runtime, we don't trust shimming.
      if (node.type === 'MemberExpression') {
        const path = memberPath(node);
        if (path && FORBIDDEN_PROCESS_METHODS.has(path)) {
          violations.push(
            makeViolation({
              rule: RULE,
              severity: 'block',
              message: `Forbidden process API '${path}'`,
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
