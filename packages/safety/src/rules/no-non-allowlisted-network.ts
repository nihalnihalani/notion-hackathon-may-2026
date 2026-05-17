import type { TSESTree } from '@typescript-eslint/utils';
import type { Rule, Violation, ScanOptions } from '../types.js';
import { walk, memberPath, makeViolation, staticStringArg } from '../ast-utils.js';

const RULE = 'no-non-allowlisted-network';

/**
 * Member-paths whose first argument is a URL/host string. These are the
 * common network entry points we expect the Tool Coder to emit.
 *
 * We deliberately match by suffix (`.request`, `.get`, `.post`) on whitelisted
 * client roots, NOT every `obj.get()` call — too many false positives.
 */
const URL_FIRST_ARG_CALLEES = new Set<string>([
  // node:http(s)
  'http.request',
  'https.request',
  'http.get',
  'https.get',
  // axios
  'axios',
  'axios.get',
  'axios.post',
  'axios.put',
  'axios.patch',
  'axios.delete',
  'axios.head',
  'axios.options',
  'axios.request',
  // got
  'got',
  'got.get',
  'got.post',
  'got.put',
  'got.patch',
  'got.delete',
  'got.head',
  // node-fetch (rarely used in Workers but defensive)
  'nodeFetch',
]);

/**
 * Extract the host from a URL-ish string. Returns null for relative URLs,
 * data: URIs, etc. — caller treats null as "not a network call".
 */
function extractHost(url: string): string | null {
  // Common non-network schemes — not a network call at all.
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) {
    return null;
  }
  try {
    // Allow protocol-relative `//host/path`
    const normalized = url.startsWith('//') ? `https:${url}` : url;
    const u = new URL(normalized);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Host check.
 *
 * Matches either:
 *   1. exact host equality (case-insensitive), OR
 *   2. wildcard prefix `*.<base>` — `*.slack.com` matches `foo.slack.com`
 *      and `bar.baz.slack.com`, but NOT the bare `slack.com`. Wildcards
 *      ONLY appear at the leading label. Bare-host coverage requires a
 *      separate non-wildcard entry.
 */
function isHostAllowed(host: string, allowlist: readonly string[]): boolean {
  const lower = host.toLowerCase();
  for (const entry of allowlist) {
    const e = entry.toLowerCase();
    if (e.startsWith('*.')) {
      const suffix = e.slice(1); // ".slack.com"
      if (lower.endsWith(suffix) && lower.length > suffix.length) return true;
      continue;
    }
    if (e === lower) return true;
  }
  return false;
}

interface CallSite {
  node: TSESTree.CallExpression;
  callee: string; // dotted-path or simple identifier name
}

/** Identify a network call site + its callee description. */
function classifyCallSite(call: TSESTree.CallExpression): CallSite | null {
  // fetch(...)
  if (call.callee.type === 'Identifier' && call.callee.name === 'fetch') {
    return { node: call, callee: 'fetch' };
  }
  // new URL(...) handled separately (NewExpression).
  if (call.callee.type === 'MemberExpression') {
    const path = memberPath(call.callee);
    if (path && URL_FIRST_ARG_CALLEES.has(path)) {
      return { node: call, callee: path };
    }
  }
  if (call.callee.type === 'Identifier' && URL_FIRST_ARG_CALLEES.has(call.callee.name)) {
    return { node: call, callee: call.callee.name };
  }
  return null;
}

/**
 * Inspect a URL argument and emit a violation if the host is non-allowlisted
 * or the URL is non-static.
 */
function inspectUrlArg(args: {
  rule: string;
  callee: string;
  node: TSESTree.Node;
  arg: TSESTree.Node | undefined;
  source: string;
  opts: ScanOptions;
}): Violation | null {
  if (!args.arg) return null;
  const literal = staticStringArg(args.arg);
  if (literal === null) {
    // Non-literal — could be safe (built from constants we can't trace), but
    // we can't prove it. Warn.
    return makeViolation({
      rule: args.rule,
      severity: 'warn',
      message: `${args.callee}(...) called with dynamic URL — cannot verify host against allowlist`,
      node: args.node,
      source: args.source,
    });
  }
  const host = extractHost(literal);
  if (host === null) {
    // Relative URL, data: URI, etc. — not a hostable network call.
    return null;
  }
  if (!isHostAllowed(host, args.opts.networkAllowlist)) {
    return makeViolation({
      rule: args.rule,
      severity: 'block',
      message: `${args.callee}(...) targets non-allowlisted host '${host}'`,
      node: args.node,
      source: args.source,
    });
  }
  return null;
}

/**
 * Block network calls to hosts not on the allowlist.
 *
 * Rationale: even if the Notion Workers runtime enforces an outbound host
 * allowlist at the network layer, defense-in-depth catches mistakes during
 * `ntn workers exec` (which may run against a local sandbox).
 */
export const noNonAllowlistedNetwork: Rule = {
  name: RULE,
  check(ast: TSESTree.Program, source: string, opts: ScanOptions): Violation[] {
    const violations: Violation[] = [];

    walk(ast, (node) => {
      if (node.type === 'CallExpression') {
        const site = classifyCallSite(node);
        if (site) {
          const v = inspectUrlArg({
            rule: RULE,
            callee: site.callee,
            node: site.node,
            arg: node.arguments[0],
            source,
            opts,
          });
          if (v) violations.push(v);
        }
      }
      // new URL(<literal>)
      if (
        node.type === 'NewExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'URL'
      ) {
        const v = inspectUrlArg({
          rule: RULE,
          callee: 'new URL',
          node,
          arg: node.arguments[0],
          source,
          opts,
        });
        if (v) violations.push(v);
      }
    });

    return violations;
  },
};
