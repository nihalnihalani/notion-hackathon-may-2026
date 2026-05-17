import { describe, expect, it, vi } from 'vitest';

import {
  checkExistingGeneration,
  DEFAULT_IDEMPOTENCY_WINDOW_MS,
} from '../src/idempotency.js';
import type { WorkflowDbHelpers } from '../src/types.js';

function makeDb(
  findRecentByHash: WorkflowDbHelpers['findRecentByHash'],
): WorkflowDbHelpers {
  return {
    findRecentByHash,
    updateGenerationStatus: vi.fn(),
    recordStep: vi.fn(),
    getWorkspaceContext: vi.fn(),
    listExistingAgents: vi.fn(),
  };
}

describe('checkExistingGeneration', () => {
  it('returns { hit: false } when no row found', async () => {
    const fn = vi.fn().mockResolvedValue(null);
    const db = makeDb(fn);
    const result = await checkExistingGeneration(db, {
      workspaceId: 'ws_1',
      descriptionHash: 'abc',
    });
    expect(result).toEqual({ hit: false });
    expect(fn).toHaveBeenCalledWith('ws_1', 'abc', DEFAULT_IDEMPOTENCY_WINDOW_MS);
  });

  it('returns { hit: true, generation } when row matches', async () => {
    const completedAt = new Date();
    const fn = vi.fn().mockResolvedValue({
      id: 'gen_cached',
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      status: 'succeeded',
      completedAt,
    });
    const db = makeDb(fn);
    const result = await checkExistingGeneration(db, {
      workspaceId: 'ws_1',
      descriptionHash: 'abc',
    });
    expect(result).toEqual({
      hit: true,
      generation: {
        id: 'gen_cached',
        workspaceId: 'ws_1',
        agentId: 'agent_1',
        completedAt,
      },
    });
  });

  it('respects `force: true` and skips the DB lookup', async () => {
    const fn = vi.fn();
    const db = makeDb(fn);
    const result = await checkExistingGeneration(db, {
      workspaceId: 'ws_1',
      descriptionHash: 'abc',
      force: true,
    });
    expect(result).toEqual({ hit: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it('treats windowMs <= 0 as a kill switch (no DB call)', async () => {
    const fn = vi.fn();
    const db = makeDb(fn);
    const result = await checkExistingGeneration(db, {
      workspaceId: 'ws_1',
      descriptionHash: 'abc',
      windowMs: 0,
    });
    expect(result).toEqual({ hit: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it('treats windowMs = NaN as a kill switch', async () => {
    const fn = vi.fn();
    const db = makeDb(fn);
    const result = await checkExistingGeneration(db, {
      workspaceId: 'ws_1',
      descriptionHash: 'abc',
      windowMs: NaN,
    });
    expect(result).toEqual({ hit: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it('uses the custom window when provided', async () => {
    const fn = vi.fn().mockResolvedValue(null);
    const db = makeDb(fn);
    await checkExistingGeneration(db, {
      workspaceId: 'ws_1',
      descriptionHash: 'abc',
      windowMs: 5_000,
    });
    expect(fn).toHaveBeenCalledWith('ws_1', 'abc', 5_000);
  });

  it('defensively skips a non-succeeded row (status mismatch)', async () => {
    const fn = vi.fn().mockResolvedValue({
      id: 'gen_1',
      workspaceId: 'ws_1',
      agentId: null,
      status: 'failed',
      completedAt: new Date(),
    });
    const db = makeDb(fn);
    const result = await checkExistingGeneration(db, {
      workspaceId: 'ws_1',
      descriptionHash: 'abc',
    });
    expect(result).toEqual({ hit: false });
  });
});
