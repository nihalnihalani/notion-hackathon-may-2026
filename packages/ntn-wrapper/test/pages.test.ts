/**
 * Tests for the Markdown helpers in `pages.ts`.
 *
 * We can't use the `process.execPath` trick from `exec.test.ts` here because
 * the wrapper builds its own argv (`['pages','create','--parent',…]`) which
 * Node would try to interpret as a script path and reject. Instead we point
 * `binary` at `/bin/echo` — it accepts arbitrary args, exits 0, and lets us
 * round-trip through `runNtn` without modelling a real CLI. The contract
 * we care about is exposed on the resolved `NtnRunResult.args`, which is the
 * exact argv the wrapper passed to spawn.
 *
 * Validation paths (invalid IDs, empty content) never spawn at all, so for
 * those we don't need a binary — the throw happens before `runNtn` is called.
 */

import { describe, expect, it } from 'vitest';

import {
  createPageMarkdown,
  NtnInvalidArgumentError,
  updatePageMarkdown,
} from '../src/index';

const ECHO_BIN = '/bin/echo';
const VALID_ID = '0123456789abcdef0123456789abcdef';

describe('createPageMarkdown', () => {
  it('builds argv with `--parent page:<id> --content <md>`', async () => {
    const result = await createPageMarkdown(
      { type: 'page', id: VALID_ID },
      '## Hello',
      { binary: ECHO_BIN, timeoutMs: 10_000 },
    );
    expect(result.args).toEqual([
      'pages',
      'create',
      '--parent',
      `page:${VALID_ID}`,
      '--content',
      '## Hello',
    ]);
    // /bin/echo prints its args back, separated by single spaces, with a
    // trailing newline — gives us a second, independent confirmation that
    // the wrapper actually spawned the child with those args.
    expect(result.stdout.trim()).toBe(
      `pages create --parent page:${VALID_ID} --content ## Hello`,
    );
  });

  it('supports database parents', async () => {
    const result = await createPageMarkdown(
      { type: 'database', id: VALID_ID },
      'body',
      { binary: ECHO_BIN, timeoutMs: 10_000 },
    );
    expect(result.args).toEqual([
      'pages',
      'create',
      '--parent',
      `database:${VALID_ID}`,
      '--content',
      'body',
    ]);
  });

  it('supports data-source parents (Notion 2025-09 API split)', async () => {
    const result = await createPageMarkdown(
      { type: 'data-source', id: VALID_ID },
      'body',
      { binary: ECHO_BIN, timeoutMs: 10_000 },
    );
    expect(result.args).toEqual([
      'pages',
      'create',
      '--parent',
      `data-source:${VALID_ID}`,
      '--content',
      'body',
    ]);
  });

  it('throws NtnInvalidArgumentError on an invalid parent id', async () => {
    await expect(
      createPageMarkdown({ type: 'page', id: 'short' }, '## hi'),
    ).rejects.toBeInstanceOf(NtnInvalidArgumentError);
    await expect(
      createPageMarkdown({ type: 'database', id: 'bad id with spaces' }, '## hi'),
    ).rejects.toBeInstanceOf(NtnInvalidArgumentError);
  });

  it('throws NtnInvalidArgumentError on empty content', async () => {
    await expect(
      createPageMarkdown({ type: 'page', id: VALID_ID }, ''),
    ).rejects.toBeInstanceOf(NtnInvalidArgumentError);
    await expect(
      createPageMarkdown({ type: 'page', id: VALID_ID }, '   \n\t  '),
    ).rejects.toBeInstanceOf(NtnInvalidArgumentError);
  });
});

describe('updatePageMarkdown', () => {
  it('builds argv with `pages update <id> --content <md>`', async () => {
    const result = await updatePageMarkdown(
      VALID_ID,
      'updated body',
      { binary: ECHO_BIN, timeoutMs: 10_000 },
    );
    expect(result.args).toEqual([
      'pages',
      'update',
      VALID_ID,
      '--content',
      'updated body',
    ]);
  });

  it('throws NtnInvalidArgumentError on an invalid page id', async () => {
    await expect(updatePageMarkdown('nope', '## hi')).rejects.toBeInstanceOf(
      NtnInvalidArgumentError,
    );
  });

  it('throws NtnInvalidArgumentError on empty content', async () => {
    await expect(updatePageMarkdown(VALID_ID, '')).rejects.toBeInstanceOf(
      NtnInvalidArgumentError,
    );
  });
});
