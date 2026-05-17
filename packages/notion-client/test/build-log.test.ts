/**
 * Build Log helper tests.
 *
 * Happy path verifies the *exact* request shape sent to Notion when an
 * entry is appended — this is the contract `/api/forge/log` depends on,
 * so a regression here would silently break the live UX.
 */

import { describe, expect, it } from 'vitest';
import {
  appendBuildLogEntry,
  buildLogBlock,
  buildLogRichText,
  clearBuildLog,
  keepRecentBuildLogEntries,
} from '../src/build-log.js';
import { asBlockId } from '../src/types.js';
import { mockFetch } from './helpers.js';

const BLOCK_ID = asBlockId('11111111-1111-1111-1111-111111111111');
const PARENT_ID = asBlockId('22222222-2222-2222-2222-222222222222');
const TS = new Date(Date.UTC(2026, 4, 17, 12, 1, 3));

describe('buildLogRichText', () => {
  it('prefixes with icon + UTC HH:MM:SS', () => {
    const parts = buildLogRichText({
      step: 'Schema Smith',
      status: 'succeeded',
      message: 'pattern = database-query',
      timestamp: TS,
    });
    expect(parts).toHaveLength(2);
    expect(parts[0]!.text.content).toBe('✅ 12:01:03  ');
    expect(parts[1]!.text.content).toBe('Schema Smith: pattern = database-query');
  });

  it('emits a red, bold text run on failure', () => {
    const parts = buildLogRichText({
      step: 'Inspector',
      status: 'failed',
      message: 'tsc error',
      timestamp: TS,
    });
    expect(parts[0]!.text.content.startsWith('❌')).toBe(true);
    expect(parts[1]!.annotations?.bold).toBe(true);
    expect(parts[1]!.annotations?.color).toBe('red');
  });

  it.each([
    ['running', '⏳'],
    ['succeeded', '✅'],
    ['failed', '❌'],
    ['info', '🔵'],
  ] as const)('uses status icon for %s', (status, icon) => {
    const parts = buildLogRichText({
      step: 'x',
      status,
      message: 'm',
      timestamp: TS,
    });
    expect(parts[0]!.text.content.startsWith(icon)).toBe(true);
  });
});

describe('buildLogBlock', () => {
  it('wraps rich-text in a paragraph block payload', () => {
    const b = buildLogBlock({
      step: 'Tool Coder',
      status: 'info',
      message: '87 lines',
      timestamp: TS,
    });
    expect(b.object).toBe('block');
    expect(b.type).toBe('paragraph');
    expect(b.paragraph.rich_text).toHaveLength(2);
  });
});

describe('appendBuildLogEntry', () => {
  it('PATCHes /v1/blocks/{id}/children with a single paragraph child', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'list', results: [], next_cursor: null, has_more: false },
    });
    await appendBuildLogEntry(
      { token: 'k', fetch },
      BLOCK_ID,
      {
        step: 'Shipper',
        status: 'succeeded',
        message: 'deployed',
        timestamp: TS,
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toMatch(
      /\/v1\/blocks\/11111111-1111-1111-1111-111111111111\/children$/,
    );
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent.children).toHaveLength(1);
    expect(sent.children[0].type).toBe('paragraph');
    expect(sent.children[0].paragraph.rich_text[0].text.content).toBe(
      '✅ 12:01:03  ',
    );
    expect(sent.children[0].paragraph.rich_text[1].text.content).toBe(
      'Shipper: deployed',
    );
  });
});

describe('clearBuildLog (O(1) archive + recreate)', () => {
  it('issues exactly two Notion requests regardless of entry count', async () => {
    // Request 1: DELETE the existing container.
    // Request 2: PATCH /v1/blocks/{parent}/children with the fresh container.
    const { fetch, calls } = mockFetch([
      { status: 200, body: { object: 'block', id: 'old-container' } },
      {
        status: 200,
        body: {
          object: 'list',
          results: [{ object: 'block', id: 'new-container', type: 'toggle' }],
          next_cursor: null,
          has_more: false,
        },
      },
    ]);
    const newId = await clearBuildLog({ token: 'k', fetch }, BLOCK_ID, PARENT_ID);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toMatch(
      /\/v1\/blocks\/11111111-1111-1111-1111-111111111111$/,
    );
    expect(calls[1]!.method).toBe('PATCH');
    expect(calls[1]!.url).toMatch(
      /\/v1\/blocks\/22222222-2222-2222-2222-222222222222\/children$/,
    );
    const body = JSON.parse(calls[1]!.body!);
    expect(body.children).toHaveLength(1);
    expect(body.children[0].type).toBe('toggle');
    expect(body.children[0].toggle.rich_text[0].text.content).toBe('Build Log');
    expect(newId).toBe('new-container');
  });

  it('accepts an override container shape (synced_block)', async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { object: 'block', id: 'old' } },
      {
        status: 200,
        body: {
          object: 'list',
          results: [{ object: 'block', id: 'new-synced', type: 'synced_block' }],
          next_cursor: null,
          has_more: false,
        },
      },
    ]);
    await clearBuildLog(
      { token: 'k', fetch },
      BLOCK_ID,
      PARENT_ID,
      {
        type: 'synced_block',
        payload: { synced_from: null, children: [] },
      },
    );
    const body = JSON.parse(calls[1]!.body!);
    expect(body.children[0].type).toBe('synced_block');
    expect(body.children[0].synced_block.synced_from).toBeNull();
  });

  it('throws when Notion returns no created block', async () => {
    const { fetch } = mockFetch([
      { status: 200, body: { object: 'block', id: 'old' } },
      {
        status: 200,
        body: { object: 'list', results: [], next_cursor: null, has_more: false },
      },
    ]);
    await expect(
      clearBuildLog({ token: 'k', fetch }, BLOCK_ID, PARENT_ID),
    ).rejects.toThrow(/empty results/);
  });
});

describe('keepRecentBuildLogEntries (O(n) trim helper)', () => {
  it('archives all entries when keepLast=0', async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: {
          object: 'list',
          results: [
            { object: 'block', id: 'b1', type: 'paragraph' },
            { object: 'block', id: 'b2', type: 'paragraph' },
          ],
          next_cursor: null,
          has_more: false,
        },
      },
      { status: 200, body: { object: 'block', id: 'b1' } },
      { status: 200, body: { object: 'block', id: 'b2' } },
    ]);
    await keepRecentBuildLogEntries({ token: 'k', fetch }, BLOCK_ID, 0);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
  });

  it('keeps the most-recent N entries (insertion order)', async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: {
          object: 'list',
          results: [
            { object: 'block', id: 'old1', type: 'paragraph' },
            { object: 'block', id: 'old2', type: 'paragraph' },
            { object: 'block', id: 'recent1', type: 'paragraph' },
            { object: 'block', id: 'recent2', type: 'paragraph' },
          ],
          next_cursor: null,
          has_more: false,
        },
      },
      { status: 200, body: { object: 'block', id: 'old1' } },
      { status: 200, body: { object: 'block', id: 'old2' } },
    ]);
    await keepRecentBuildLogEntries({ token: 'k', fetch }, BLOCK_ID, 2);
    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(2);
    expect(deletes[0]!.url).toMatch(/\/v1\/blocks\/old1$/);
    expect(deletes[1]!.url).toMatch(/\/v1\/blocks\/old2$/);
  });

  it('paginates through has_more cursors when listing children', async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: {
          object: 'list',
          results: [{ object: 'block', id: 'b1' }],
          next_cursor: 'cur1',
          has_more: true,
        },
      },
      {
        status: 200,
        body: {
          object: 'list',
          results: [{ object: 'block', id: 'b2' }],
          next_cursor: null,
          has_more: false,
        },
      },
      { status: 200, body: { object: 'block', id: 'b1' } },
      { status: 200, body: { object: 'block', id: 'b2' } },
    ]);
    await keepRecentBuildLogEntries({ token: 'k', fetch }, BLOCK_ID, 0);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
    expect(calls[1]!.url).toContain('start_cursor=cur1');
  });

  it('rejects negative keepLast', async () => {
    const { fetch } = mockFetch({ status: 200, body: {} });
    await expect(
      keepRecentBuildLogEntries({ token: 'k', fetch }, BLOCK_ID, -1),
    ).rejects.toThrow(/keepLast must be >= 0/);
  });
});
