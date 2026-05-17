import type { TSESTree } from '@typescript-eslint/utils';
import type { Rule, Violation } from '../types.js';
import { walk, makeViolation } from '../ast-utils.js';

const RULE = 'no-eval';

/**
 * Block all forms of runtime code evaluation in generated Worker code.
 *
 * Blocked:
 *   - eval(...)
 *   - globalThis.eval(...) / window.eval(...) — covered by Identifier match below
 *     because `eval` is reserved-keyword-ish and shimming it is exotic
 *   - new Function(...)
 *   - import(<dynamic-expression>) where the argument is anything other than
 *     a plain string literal (template-with-vars, identifier, binary expr, etc.)
 *
 * Allowed:
 *   - import('@notionhq/client') — static string literal, used legitimately
 *     by some bundler output
 */
export const noEval: Rule = {
  name: RULE,
  check(ast: TSESTree.Program, source: string): Violation[] {
    const violations: Violation[] = [];

    walk(ast, (node) => {
      // eval(...)
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'eval'
      ) {
        violations.push(
          makeViolation({
            rule: RULE,
            severity: 'block',
            message: 'Use of eval() is forbidden',
            node,
            source,
          }),
        );
        return;
      }

      // globalThis.eval(...) / window.eval(...) / self.eval(...)
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'MemberExpression' &&
        !node.callee.computed &&
        node.callee.property.type === 'Identifier' &&
        node.callee.property.name === 'eval'
      ) {
        violations.push(
          makeViolation({
            rule: RULE,
            severity: 'block',
            message: 'Use of eval() via member access is forbidden',
            node,
            source,
          }),
        );
        return;
      }

      // new Function(...)
      if (
        node.type === 'NewExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'Function'
      ) {
        violations.push(
          makeViolation({
            rule: RULE,
            severity: 'block',
            message: 'new Function() constructor is forbidden',
            node,
            source,
          }),
        );
        return;
      }

      // Dynamic import — only allow plain string literal arg.
      if (node.type === 'ImportExpression') {
        const arg = node.source;
        const isStaticString = arg.type === 'Literal' && typeof arg.value === 'string';
        if (!isStaticString) {
          violations.push(
            makeViolation({
              rule: RULE,
              severity: 'block',
              message: 'Dynamic import() argument must be a static string literal',
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
