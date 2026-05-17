/**
 * TypeScript validation helpers used by Tool Coder.
 *
 * Two pure functions:
 *
 *  - {@link parseGeneratedTs} runs `@typescript-eslint/parser` over the
 *    generated source and returns a tagged result. We do NOT throw — the
 *    Tool Coder feeds the error string into the retry prompt, so propagating
 *    a stack trace would be counter-productive.
 *
 *  - {@link extractTsCodeFromResponse} peels a TS code block out of a model
 *    response. We accept three forms (in order of preference):
 *      1. ```typescript ... ``` fenced block
 *      2. ```ts ... ``` fenced block
 *      3. any bare ``` ... ``` fenced block
 *      4. raw source — only if the trimmed body parses on its own. We pick
 *         "parses" as the disambiguator rather than "starts with `import`"
 *         because tool calls and `worker.tool()` chains routinely don't start
 *         with imports if the boilerplate is moved later in the file.
 *
 * Neither function does IO. Both can be safely called from any runtime.
 */

import { parse } from '@typescript-eslint/parser';

/** Result of {@link parseGeneratedTs}. Errors are pre-formatted for prompts. */
export type ParseGeneratedTsResult =
  | { ok: true }
  | { ok: false; errors: string[] };

const PARSER_OPTIONS = Object.freeze({
  // Matches @forge/safety's scanner parser config so a successful parse here
  // implies the safety scanner will at least not bail at PARSE stage.
  jsx: false,
  loc: true,
  range: true,
  ecmaVersion: 2022 as const,
  sourceType: 'module' as const,
});

/**
 * Parse `source` with the TypeScript-ESLint parser. Pure.
 *
 * Returns:
 *   - `{ ok: true }` when the source parses without error.
 *   - `{ ok: false, errors }` with a 1-element array — the parser only
 *     surfaces the first syntax error before bailing. We keep the API
 *     plural-shaped for forward compatibility (multi-pass parsing, lint
 *     warnings) without churning every caller.
 */
export function parseGeneratedTs(source: string): ParseGeneratedTsResult {
  try {
    parse(source, PARSER_OPTIONS);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [message] };
  }
}

/**
 * Extract a single TypeScript code block from a model response.
 *
 * Returns `null` when no plausible TS block is present — callers must treat
 * `null` as a parse-stage failure (not a retry-eligible "model added prose").
 *
 * Precedence:
 *   1. The FIRST ```typescript / ```ts fenced block.
 *   2. The FIRST bare ``` fenced block (we trust the model not to mix
 *      languages within a single response).
 *   3. The raw body iff it parses standalone.
 */
export function extractTsCodeFromResponse(text: string): string | null {
  if (text.length === 0) return null;

  // 1 + 2: fenced blocks. Match `typescript` / `ts` first by trying that
  // regex; fall through to the looser bare-fence regex if not present. We
  // run two scans rather than one alternation because the alternation would
  // greedily prefer whichever fence appeared first in the text — but in
  // practice the model emits the typed fence WHEN IT EMITS ONE AT ALL, so
  // preferring it is the right disambiguator.
  const tsFence = /```(?:typescript|ts)\s*\n?([\s\S]*?)```/u.exec(text);
  if (tsFence?.[1]) {
    const inner = stripBom(tsFence[1].replace(/\s+$/u, ''));
    return inner.length === 0 ? null : inner;
  }

  const anyFence = /```(?:[a-zA-Z0-9_-]*)?\s*\n?([\s\S]*?)```/u.exec(text);
  if (anyFence?.[1]) {
    const inner = stripBom(anyFence[1].replace(/\s+$/u, ''));
    if (inner.length === 0) return null;
    // Only accept the bare fence if it parses — protects against an
    // accidental ```json block that wasn't intended as TS.
    return parseGeneratedTs(inner).ok ? inner : null;
  }

  // 3: raw source. Accept iff it parses standalone — otherwise we'd return a
  // prose paragraph that downstream parse will reject anyway, but with a
  // much less actionable error string.
  const trimmed = stripBom(text.trim());
  if (trimmed.length === 0) return null;
  return parseGeneratedTs(trimmed).ok ? trimmed : null;
}

/** Strip a UTF-8 BOM if present. Models sometimes emit one inside code blocks. */
function stripBom(s: string): string {
  return s.codePointAt(0) === 0xFE_FF ? s.slice(1) : s;
}
