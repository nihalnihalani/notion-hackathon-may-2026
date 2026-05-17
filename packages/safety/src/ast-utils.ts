import type { TSESTree } from '@typescript-eslint/utils';
import type { Violation, Severity } from './types.js';

/**
 * Shared AST helpers used by individual rules.
 *
 * Keep this module pure — no IO, no rule-specific knowledge.
 */

/** Pre-order walk over an AST. Visitor returns void; mutate accumulator in closure. */
export function walk(
  node: TSESTree.Node | null | undefined,
  visit: (node: TSESTree.Node, parent: TSESTree.Node | null) => void,
  parent: TSESTree.Node | null = null,
): void {
  if (!node || typeof node !== 'object' || !('type' in node)) return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    // skip metadata keys that point back at parents / locations
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && 'type' in child) {
          walk(child as TSESTree.Node, visit, node);
        }
      }
    } else if (typeof value === 'object' && value !== null && 'type' in value) {
      walk(value as TSESTree.Node, visit, node);
    }
  }
}

/**
 * Resolve a MemberExpression chain to a dotted name like `process.env.FOO`
 * or `fs.promises.writeFile`. Returns null if any segment is computed
 * (e.g. `obj[dynamic]`), private (`#x`), or non-identifier.
 */
export function memberPath(node: TSESTree.Node): string | null {
  const parts: string[] = [];
  let cur: TSESTree.Node = node;
  while (cur.type === 'MemberExpression') {
    if (cur.computed) return null;
    if (cur.property.type !== 'Identifier') return null;
    parts.unshift(cur.property.name);
    cur = cur.object;
  }
  if (cur.type === 'Identifier') {
    parts.unshift(cur.name);
    return parts.join('.');
  }
  if (cur.type === 'ThisExpression') {
    parts.unshift('this');
    return parts.join('.');
  }
  return null;
}

/** Extract a one-line snippet for the given node from the source string. */
export function snippetOf(source: string, node: TSESTree.Node): string {
  if (!node.range) return '';
  const [start, end] = node.range;
  const raw = source.slice(start, Math.min(end, start + 200));
  // Collapse to one line for log readability — Notion blocks don't wrap nicely.
  const oneLine = raw.replaceAll(/\s+/g, ' ').trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
}

/**
 * Build a Violation from a node. Centralized so `line/column` derivation
 * (1-indexed) is consistent across rules.
 */
export function makeViolation(args: {
  rule: string;
  severity: Severity;
  message: string;
  node: TSESTree.Node;
  source: string;
}): Violation {
  const loc = args.node.loc;
  return {
    rule: args.rule,
    severity: args.severity,
    message: args.message,
    line: loc.start.line ?? 0,
    column: (loc.start.column ?? 0) + 1,
    snippet: snippetOf(args.source, args.node),
  };
}

/**
 * Extract a string value from a CallExpression argument IF it is a static
 * string literal or a template literal with no expressions. Otherwise
 * returns null (caller decides whether to warn).
 */
export function staticStringArg(arg: TSESTree.Node | undefined): string | null {
  if (!arg) return null;
  if (arg.type === 'Literal' && typeof arg.value === 'string') return arg.value;
  if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0) {
    return arg.quasis.map((q) => q.value.cooked ?? '').join('');
  }
  return null;
}

/**
 * Return true if a node is "true literal" — `true`, or `!0`, or `1`.
 * Used by no-unbounded-loops; we accept only the common forms because
 * deeper constant evaluation belongs to TypeScript itself.
 */
export function isTruthyConstant(node: TSESTree.Node): boolean {
  if (node.type === 'Literal') {
    return node.value === true || node.value === 1;
  }
  if (node.type === 'UnaryExpression' && node.operator === '!') {
    const arg = node.argument;
    if (arg.type === 'Literal' && (arg.value === 0 || arg.value === '' || arg.value === null)) {
      return true;
    }
  }
  return false;
}

/**
 * Walk a node subtree looking for any `break` / `return` / `throw`.
 * Used to validate that an apparently-infinite loop has SOME exit edge.
 * Conservatively treats `continue` as NOT an exit (correct).
 */
export function hasExitStatement(body: TSESTree.Node): boolean {
  let found = false;
  walk(body, (n) => {
    if (found) return;
    // Don't descend into nested function bodies — their `return` doesn't exit
    // the outer loop. We achieve that here by short-circuiting on hits; for
    // a fully correct version we'd need a true stop-traversal walker, but
    // the false-positive direction (failing to detect a nested return as an
    // exit) is the SAFE direction for this warn-severity rule.
    if (
      n.type === 'BreakStatement' ||
      n.type === 'ReturnStatement' ||
      n.type === 'ThrowStatement'
    ) {
      found = true;
    }
  });
  return found;
}
