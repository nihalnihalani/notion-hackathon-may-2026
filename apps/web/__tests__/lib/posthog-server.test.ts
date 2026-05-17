/**
 * Tests for `lib/posthog-server.ts`.
 *
 * What we care about:
 *   - `captureEvent` forwards `{ userId, workspaceId, event, properties }`
 *     to `posthog-node` with the workspace attached as a group identifier.
 *   - The function is a no-op when `POSTHOG_KEY` is unset (dev DX).
 *   - Errors thrown from inside the PostHog client are swallowed (analytics
 *     must never break a request).
 *   - `flushEvents` resolves cleanly when no client is configured.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captureMock = vi.fn();
const flushMock = vi.fn().mockResolvedValue(undefined);
const shutdownMock = vi.fn().mockResolvedValue(undefined);

vi.mock('posthog-node', () => ({
  PostHog: vi.fn().mockImplementation(() => ({
    capture: captureMock,
    flush: flushMock,
    shutdown: shutdownMock,
  })),
}));

describe('posthog-server', () => {
  beforeEach(() => {
    vi.resetModules();
    captureMock.mockReset();
    flushMock.mockReset().mockResolvedValue(undefined);
    shutdownMock.mockReset().mockResolvedValue(undefined);
    delete process.env['POSTHOG_KEY'];
    delete process.env['POSTHOG_HOST'];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op when POSTHOG_KEY is unset', async () => {
    const mod = await import('@/lib/posthog-server');
    mod.captureEvent({
      userId: 'user_123',
      event: 'forge.generation.requested',
    });
    expect(captureMock).not.toHaveBeenCalled();
    await expect(mod.flushEvents()).resolves.toBeUndefined();
  });

  it('forwards the canonical capture shape to posthog-node', async () => {
    process.env['POSTHOG_KEY'] = 'phc_test';
    const mod = await import('@/lib/posthog-server');
    mod.__resetForTests();

    mod.captureEvent({
      userId: 'user_123',
      workspaceId: 'ws_456',
      event: 'forge.generation.completed',
      properties: {
        generationId: 'gen_789',
        pattern: 'lookup',
        totalCostUsd: 0.0421,
        totalLatencyMs: 12_345,
      },
    });

    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith({
      distinctId: 'user_123',
      event: 'forge.generation.completed',
      properties: {
        generationId: 'gen_789',
        pattern: 'lookup',
        totalCostUsd: 0.0421,
        totalLatencyMs: 12_345,
      },
      groups: { workspace: 'ws_456' },
    });
  });

  it('omits the groups field when no workspaceId is supplied', async () => {
    process.env['POSTHOG_KEY'] = 'phc_test';
    const mod = await import('@/lib/posthog-server');
    mod.__resetForTests();

    mod.captureEvent({
      userId: 'user_123',
      event: 'forge.settings.api_key_created',
    });

    expect(captureMock).toHaveBeenCalledWith({
      distinctId: 'user_123',
      event: 'forge.settings.api_key_created',
      properties: {},
    });
  });

  it('swallows errors thrown by the PostHog client', async () => {
    process.env['POSTHOG_KEY'] = 'phc_test';
    captureMock.mockImplementationOnce(() => {
      throw new Error('network gone');
    });

    const mod = await import('@/lib/posthog-server');
    mod.__resetForTests();

    expect(() =>
      mod.captureEvent({
        userId: 'user_123',
        event: 'forge.generation.failed',
        properties: { errorCode: 'E_UPSTREAM' },
      }),
    ).not.toThrow();
  });

  it('flushEvents calls the underlying client flush', async () => {
    process.env['POSTHOG_KEY'] = 'phc_test';
    const mod = await import('@/lib/posthog-server');
    mod.__resetForTests();

    // Trigger client construction.
    mod.captureEvent({ userId: 'u', event: 'e' });

    await mod.flushEvents();
    expect(flushMock).toHaveBeenCalledTimes(1);
  });
});
