import { describe, expect, it, vi } from 'vitest';

import {
  __resetCachedRunner,
  cancelInflight,
  publishGenerationCancelled,
  publishGenerationRequested,
  type WorkflowRunner,
} from '../src/triggers.js';
import type { GenerationRequestedEvent } from '../src/types.js';

function makePayload(
  overrides: Partial<GenerationRequestedEvent> = {},
): GenerationRequestedEvent {
  return {
    generationId: 'gen_1',
    workspaceId: 'ws_1',
    notionWorkspaceId: 'notion_ws_1',
    userId: 'user_1',
    userEmail: 'a@b.com',
    description: 'do stuff',
    descriptionHash: 'a'.repeat(64),
    buildLogBlockId: 'block_1' as never,
    notionRequestRowId: 'row_1',
    ...overrides,
  };
}

describe('publishGenerationRequested', () => {
  it('forwards to runner.start with the workflow name + payload', async () => {
    __resetCachedRunner();
    const runner: WorkflowRunner = {
      start: vi.fn().mockResolvedValue({ runId: 'run_42' }),
    };
    const result = await publishGenerationRequested(makePayload(), { runner });
    expect(result).toEqual({ runId: 'run_42' });
    expect(runner.start).toHaveBeenCalledWith('forge-generation', [makePayload()]);
  });

  it('uses workflowRef when provided', async () => {
    __resetCachedRunner();
    const runner: WorkflowRunner = {
      start: vi.fn().mockResolvedValue({ runId: 'run_1' }),
    };
    const workflowRef = function forgeGeneration() {
      /* fake */
    };
    await publishGenerationRequested(makePayload(), { runner, workflowRef });
    expect(runner.start).toHaveBeenCalledWith(workflowRef, [makePayload()]);
  });

  it('throws on missing required fields', async () => {
    __resetCachedRunner();
    const runner: WorkflowRunner = { start: vi.fn() };
    await expect(
      publishGenerationRequested(
        makePayload({ generationId: '' }),
        { runner },
      ),
    ).rejects.toThrow(/generationId/);
  });

  it('throws on bad descriptionHash length', async () => {
    __resetCachedRunner();
    const runner: WorkflowRunner = { start: vi.fn() };
    await expect(
      publishGenerationRequested(
        makePayload({ descriptionHash: 'short' }),
        { runner },
      ),
    ).rejects.toThrow(/64 hex chars/);
  });
});

describe('publishGenerationCancelled', () => {
  it('delegates to runner.resumeHook with the cancellation payload', async () => {
    __resetCachedRunner();
    const runner: WorkflowRunner = {
      start: vi.fn(),
      resumeHook: vi.fn().mockResolvedValue({ runId: 'run_1' }),
    };
    const result = await publishGenerationCancelled('gen_1', 'user', {
      runner,
      hookToken: 'tok_1',
    });
    expect(result).toEqual({ runId: 'run_1' });
    expect(runner.resumeHook).toHaveBeenCalledWith('tok_1', {
      generationId: 'gen_1',
      reason: 'user',
    });
  });

  it('returns { skipped: true } when runner has no resumeHook', async () => {
    __resetCachedRunner();
    const runner: WorkflowRunner = { start: vi.fn() };
    const result = await publishGenerationCancelled('gen_1', 'timeout', {
      runner,
      hookToken: 'tok_1',
    });
    expect(result).toEqual({ skipped: true });
  });
});

describe('cancelInflight', () => {
  it('returns { skipped: true } when no hookToken is supplied', async () => {
    __resetCachedRunner();
    const runner: WorkflowRunner = { start: vi.fn() };
    const result = await cancelInflight('gen_1', 'admin', { runner });
    expect(result).toEqual({ skipped: true });
  });

  it('delegates to publishGenerationCancelled when hookToken present', async () => {
    __resetCachedRunner();
    const runner: WorkflowRunner = {
      start: vi.fn(),
      resumeHook: vi.fn().mockResolvedValue({ runId: 'r' }),
    };
    const result = await cancelInflight('gen_1', 'admin', {
      runner,
      hookToken: 'tok_X',
    });
    expect(result).toEqual({ runId: 'r' });
    expect(runner.resumeHook).toHaveBeenCalledWith('tok_X', {
      generationId: 'gen_1',
      reason: 'admin',
    });
  });
});
