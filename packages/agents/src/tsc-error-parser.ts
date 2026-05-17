/**
 * Parse TypeScript Compiler (`tsc`) error output into a structured array.
 *
 * `tsc` prints diagnostics in a single canonical format:
 *
 *   src/path/to/file.ts(LINE,COLUMN): error TSCODE: message text...
 *
 * Multi-line diagnostics (with leading whitespace) wrap the message; we
 * concatenate the continuation lines onto the preceding diagnostic so the
 * Inspector can feed a coherent error back to Tool Coder for retry.
 *
 * Pure function — no IO, no globals — so it can run in any runtime.
 *
 * SECURITY: We accept arbitrary string input (stderr or stdout from the
 * sandbox subprocess). The regex is anchored and bounded; we cap the message
 * accumulator to keep memory bounded under pathological output.
 */

/**
 * A single parsed tsc diagnostic.
 */
export interface TscError {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

// `(?<file>...)(line,column): error TSXXXX: message`
// The file portion is anything up to the trailing `(`. We deliberately do not
// constrain it to a TS extension — `tsc --noEmit` can emit diagnostics against
// .d.ts and .json files (with `resolveJsonModule`).
const DIAGNOSTIC_RE = /^(?<file>.+?)\((?<line>\d+),(?<col>\d+)\):\s+error\s+(?<code>TS\d+):\s+(?<msg>.*)$/u;

/** Hard cap on diagnostic message length — avoids pathological mid-line continuations. */
const MAX_MESSAGE_BYTES = 8 * 1024;

/**
 * Parse a `tsc --noEmit` stderr blob into structured diagnostics.
 *
 * Returns `[]` for:
 *  - empty / whitespace-only input
 *  - input containing only non-diagnostic noise (e.g. `[Files: ...]`)
 *
 * Wrapped continuation lines (any line that begins with whitespace AND
 * follows a matched diagnostic) are appended to the preceding message
 * separated by `\n`. Continuations seen before any diagnostic are dropped.
 */
export function parseTscErrors(stderr: string): TscError[] {
  if (stderr.length === 0) {
    return [];
  }
  const errors: TscError[] = [];
  const lines = stderr.split(/\r?\n/u);

  for (const line of lines) {
    const match = DIAGNOSTIC_RE.exec(line);
    if (match?.groups !== undefined) {
      const { file, line: lineStr, col, code, msg } = match.groups;
      // The regex above guarantees these keys exist; the optional-property
      // index access is just `noUncheckedIndexedAccess` placation.
      if (
        file === undefined ||
        lineStr === undefined ||
        col === undefined ||
        code === undefined ||
        msg === undefined
      ) {
        continue;
      }
      errors.push({
        file,
        line: Number.parseInt(lineStr, 10),
        column: Number.parseInt(col, 10),
        code,
        message: msg.trim(),
      });
      continue;
    }
    // Continuation: starts with whitespace AND we have a prior diagnostic.
    if (/^\s+\S/u.test(line) && errors.length > 0) {
      const previous = errors[errors.length - 1];
      if (previous === undefined) {
        continue;
      }
      const candidate = `${previous.message}\n${line.trim()}`;
      previous.message = candidate.length > MAX_MESSAGE_BYTES ? candidate.slice(0, MAX_MESSAGE_BYTES) : candidate;
    }
    // Anything else (banner lines, blank lines, `Found N errors`) is ignored.
  }

  return errors;
}
