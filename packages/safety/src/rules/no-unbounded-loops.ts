import type { TSESTree } from '@typescript-eslint/utils';
import type { Rule, Violation } from '../types.js';
import { walk, makeViolation, isTruthyConstant, hasExitStatement } from '../ast-utils.js';

const RULE = 'no-unbounded-loops';

/**
 * Warn on apparent infinite loops with no exit edge.
 *
 * Specifically: `while(true)`, `for(;;)`, `do {} while(true)` whose body has
 * NO `break` / `return` / `throw`.
 *
 * False positives are fine — the worst outcome is a human reword. False
 * negatives (CPU-burn loops shipped to prod) cost real money.
 *
 * Severity is `warn` not `block` because some sync-source agents legitimately
 * use `while(cursor){ cursor = await next(cursor) }` style — those have an
 * implicit break via loop-condition update, which we WILL flag here but
 * shouldn't block. The reviewer or the user decides.
 */
export const noUnboundedLoops: Rule = {
  name: RULE,
  check(ast: TSESTree.Program, source: string): Violation[] {
    const violations: Violation[] = [];

    walk(ast, (node) => {
      // while(true) { ... }
      if (
        node.type === 'WhileStatement' &&
        isTruthyConstant(node.test) &&
        !hasExitStatement(node.body)
      ) {
        violations.push(
          makeViolation({
            rule: RULE,
            severity: 'warn',
            message: 'while(true) loop with no break/return/throw — possible infinite loop',
            node,
            source,
          }),
        );
      }
      // do { ... } while(true)
      if (
        node.type === 'DoWhileStatement' &&
        isTruthyConstant(node.test) &&
        !hasExitStatement(node.body)
      ) {
        violations.push(
          makeViolation({
            rule: RULE,
            severity: 'warn',
            message: 'do/while(true) loop with no break/return/throw — possible infinite loop',
            node,
            source,
          }),
        );
      }
      // for(;;) — `test === null` means empty
      if (node.type === 'ForStatement' && node.test === null && !hasExitStatement(node.body)) {
        violations.push(
          makeViolation({
            rule: RULE,
            severity: 'warn',
            message: 'for(;;) loop with no break/return/throw — possible infinite loop',
            node,
            source,
          }),
        );
      }
    });

    return violations;
  },
};
