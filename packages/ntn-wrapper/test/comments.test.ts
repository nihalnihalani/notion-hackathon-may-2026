/**
 * Tests for `comments.ts`. The wrapper goes through `callNotionApi` which
 * uses `runNtnJson` (i.e. parses stdout as JSON), so the fake binary needs
 * to do two things:
 *
 *   1. Re-emit its own argv to stderr so the test can inspect what would have
 *      been passed to real `ntn`.
 *   2. Print a JSON envelope on stdout so `runNtnJson` doesn't choke.
 *
 * We write a tiny Node script to a tmp file at setup, mark it executable,
 * and point `binary` at it. Cleanup runs in `afterAll`. This is the closest
 * we can get to the `process.execPath` pattern in `exec.test.ts` without
 * making the wrapper inject `-e <script>` into its own argv.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NtnInvalidArgumentError, createComment } from '../src/index';

let tmpDir: string;
let fakeBinary: string;
let stderrCapturePath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ntn-comments-test-'));
  fakeBinary = join(tmpDir, 'fake-ntn.js');
  stderrCapturePath = join(tmpDir, 'argv.json');

  // The fake binary:
  //   - Writes its own argv (sans `node` + script path) as JSON to a known
  //     file the test can read back. We use a file rather than stderr because
  //     `runNtn` truncates stderr at 1 MiB by default and we want a clean
  //     deterministic read.
  //   - Echoes `{"ok":true}` on stdout so `runNtnJson` parses successfully.
  const script = [
    '#!/usr/bin/env node',
    `const fs = require('node:fs');`,
    `const argv = process.argv.slice(2);`,
    `fs.writeFileSync(${JSON.stringify(stderrCapturePath)}, JSON.stringify(argv));`,
    `process.stdout.write('{"ok":true,"id":"cmt_fake"}');`,
    `process.exit(0);`,
  ].join('\n');

  writeFileSync(fakeBinary, script, 'utf8');
  chmodSync(fakeBinary, 0o755);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const VALID_PAGE_ID = '0123456789abcdef0123456789abcdef';
const VALID_DISCUSSION_ID = 'disc_0123456789abcdef';

describe('createComment — validation', () => {
  it('throws when neither pageId nor discussionId is provided', async () => {
    await expect(
      createComment({ markdown: 'hi' }),
    ).rejects.toBeInstanceOf(NtnInvalidArgumentError);
  });

  it('throws when both pageId and discussionId are provided', async () => {
    await expect(
      createComment({
        pageId: VALID_PAGE_ID,
        discussionId: VALID_DISCUSSION_ID,
        markdown: 'hi',
      }),
    ).rejects.toBeInstanceOf(NtnInvalidArgumentError);
  });

  it('throws when pageId is an empty string (treated as absent)', async () => {
    await expect(
      createComment({ pageId: '', markdown: 'hi' }),
    ).rejects.toBeInstanceOf(NtnInvalidArgumentError);
  });

  it('throws when markdown is empty / whitespace-only', async () => {
    await expect(
      createComment({ pageId: VALID_PAGE_ID, markdown: '' }),
    ).rejects.toBeInstanceOf(NtnInvalidArgumentError);
    await expect(
      createComment({ pageId: VALID_PAGE_ID, markdown: '   \n\t  ' }),
    ).rejects.toBeInstanceOf(NtnInvalidArgumentError);
  });
});

describe('createComment — request body', () => {
  it('sends `parent.page_id` + `markdown` when pageId is given', async () => {
    const result = await createComment<{ ok: boolean; id: string }>(
      { pageId: VALID_PAGE_ID, markdown: 'hello world' },
      { binary: fakeBinary, timeoutMs: 10_000 },
    );

    expect(result).toEqual({ ok: true, id: 'cmt_fake' });

    // Read back the captured argv and locate `--data <json>`.
    const argv = JSON.parse(readFileSync(stderrCapturePath, 'utf8')) as string[];

    expect(argv[0]).toBe('api');
    expect(argv[1]).toBe('v1/comments');

    const dataIdx = argv.indexOf('--data');
    expect(dataIdx).toBeGreaterThanOrEqual(0);
    const body = JSON.parse(argv[dataIdx + 1]!) as {
      parent: { page_id?: string; discussion_id?: string };
      markdown: string;
    };
    expect(body).toEqual({
      parent: { page_id: VALID_PAGE_ID },
      markdown: 'hello world',
    });
    // Must NOT contain the other variant.
    expect(body.parent.discussion_id).toBeUndefined();

    // `--json` is appended by `callNotionApi` so the response is parsed.
    expect(argv).toContain('--json');
  });

  it('sends `parent.discussion_id` + `markdown` when discussionId is given', async () => {
    await createComment(
      { discussionId: VALID_DISCUSSION_ID, markdown: 'reply' },
      { binary: fakeBinary, timeoutMs: 10_000 },
    );

    const argv = JSON.parse(readFileSync(stderrCapturePath, 'utf8')) as string[];

    const dataIdx = argv.indexOf('--data');
    const body = JSON.parse(argv[dataIdx + 1]!) as {
      parent: { page_id?: string; discussion_id?: string };
      markdown: string;
    };
    expect(body).toEqual({
      parent: { discussion_id: VALID_DISCUSSION_ID },
      markdown: 'reply',
    });
    expect(body.parent.page_id).toBeUndefined();
  });
});
