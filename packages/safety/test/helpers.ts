import { parse } from '@typescript-eslint/parser';
import type { TSESTree } from '@typescript-eslint/utils';
import type { Rule, ScanOptions, Violation } from '../src/types.js';

export const TEST_OPTS: ScanOptions = {
  networkAllowlist: ['api.notion.com', 'www.notion.so'],
  depAllowlist: ['@notionhq/client', '@notion/workers-sdk', 'zod', 'date-fns'],
};

export function parseTs(source: string): TSESTree.Program {
  return parse(source, {
    jsx: true,
    loc: true,
    range: true,
    ecmaVersion: 2022,
    sourceType: 'module',
  }) as TSESTree.Program;
}

export function runRule(
  rule: Rule,
  source: string,
  opts: ScanOptions = TEST_OPTS,
): Violation[] {
  return rule.check(parseTs(source), source, opts);
}
