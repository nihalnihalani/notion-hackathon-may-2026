/**
 * /api/forge/voice — speech-to-text via MiniMax.
 *   missing config    → 503
 *   no audio part     → 400
 *   empty audio       → 400
 *   too-large audio   → 400
 *   wrong MIME        → 400
 *   happy path        → 200 { text }
 *   minimax failure   → 502
 *   unauthenticated   → 401
 *   rate limited      → 429
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCtx, readJson, stubSentryWrapper } from './_helpers';

stubSentryWrapper();

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
}));

vi.mock('@forge/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
  },
}));

const transcribeMock = vi.fn();
vi.mock('@forge/connectors', () => ({
  createMinimaxClient: () => ({
    transcribe: (...args: unknown[]) => transcribeMock(...args),
  }),
}));

const checkRateLimitMock = vi.fn();
const createRateLimiterMock = vi.fn().mockReturnValue({});
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  createRateLimiter: (...args: unknown[]) => createRateLimiterMock(...args),
  limiters: {},
}));

vi.mock('@/lib/posthog', () => ({ capture: vi.fn() }));

const fakeUser = {
  id: 'user_1',
  email: 'nihal@example.com',
  workspace: {
    id: 'ws_1',
    notionWorkspaceId: 'nws_1',
    forgeBuildLogBlockId: 'blk_log_1',
  },
};

function makeMultipart(blob: Blob | undefined, filename = 'note.webm'): Request {
  const form = new FormData();
  if (blob !== undefined) form.append('audio', blob, filename);
  return new Request('http://localhost/api/forge/voice', {
    method: 'POST',
    body: form,
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  const clerk = await import('@clerk/nextjs/server');
  vi.mocked(clerk.auth).mockResolvedValue({ userId: 'clerk_1' } as never);

  const db = await import('@forge/db');
  vi.mocked(db.prisma.user.findUnique).mockResolvedValue(fakeUser as never);

  checkRateLimitMock.mockResolvedValue({ success: true, reset: 0, remaining: 19, limit: 20 });

  // Default: env is configured. Each test that wants 503 unsets these.
  process.env['MINIMAX_API_KEY'] = 'test-minimax-key';

  transcribeMock.mockResolvedValue({
    text: 'Pull my Linear bugs hourly into Notion.',
    language: 'en',
    base_resp: { status_code: 0, status_msg: 'success' },
  });
});

afterEach(() => {
  delete process.env['MINIMAX_API_KEY'];
  vi.resetModules();
});

describe('POST /api/forge/voice', () => {
  it('happy path: transcribes audio and returns { text, language }', async () => {
    const { POST } = await import('@/app/api/forge/voice/route');
    const audio = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' });
    const res = await POST(makeMultipart(audio, 'note.webm') as never, makeCtx({}));
    expect(res.status).toBe(200);
    const body = await readJson<{ text: string; language?: string }>(res);
    expect(body.text).toContain('Linear');
    expect(body.language).toBe('en');
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    expect(transcribeMock.mock.calls[0]?.[0]).toMatchObject({ format: 'webm' });
  });

  it('returns 503 when MINIMAX_API_KEY is missing', async () => {
    delete process.env['MINIMAX_API_KEY'];
    const { POST } = await import('@/app/api/forge/voice/route');
    const audio = new Blob([new Uint8Array([1])], { type: 'audio/webm' });
    const res = await POST(makeMultipart(audio) as never, makeCtx({}));
    expect(res.status).toBe(503);
  });

  it('returns 400 when audio part is missing', async () => {
    const { POST } = await import('@/app/api/forge/voice/route');
    const res = await POST(makeMultipart(undefined) as never, makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 on empty audio payload', async () => {
    const { POST } = await import('@/app/api/forge/voice/route');
    const audio = new Blob([], { type: 'audio/webm' });
    const res = await POST(makeMultipart(audio) as never, makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 on too-large audio', async () => {
    const { POST } = await import('@/app/api/forge/voice/route');
    // 5 MiB > MAX_AUDIO_BYTES (4 MiB)
    const audio = new Blob([new Uint8Array(5 * 1024 * 1024)], { type: 'audio/webm' });
    const res = await POST(makeMultipart(audio) as never, makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 on explicitly wrong MIME (image/png)', async () => {
    const { POST } = await import('@/app/api/forge/voice/route');
    const audio = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const res = await POST(makeMultipart(audio, 'note.png') as never, makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('returns 502 when MiniMax throws', async () => {
    transcribeMock.mockRejectedValue(new Error('upstream 500'));
    const { POST } = await import('@/app/api/forge/voice/route');
    const audio = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' });
    const res = await POST(makeMultipart(audio) as never, makeCtx({}));
    expect(res.status).toBe(502);
  });

  it('returns 502 when MiniMax returns empty text', async () => {
    transcribeMock.mockResolvedValue({
      text: '',
      base_resp: { status_code: 0, status_msg: 'success' },
    });
    const { POST } = await import('@/app/api/forge/voice/route');
    const audio = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' });
    const res = await POST(makeMultipart(audio) as never, makeCtx({}));
    expect(res.status).toBe(502);
  });

  it('returns 401 when there is no Clerk session', async () => {
    const clerk = await import('@clerk/nextjs/server');
    vi.mocked(clerk.auth).mockResolvedValue({ userId: null } as never);
    const { POST } = await import('@/app/api/forge/voice/route');
    const audio = new Blob([new Uint8Array([1])], { type: 'audio/webm' });
    const res = await POST(makeMultipart(audio) as never, makeCtx({}));
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate limited', async () => {
    checkRateLimitMock.mockResolvedValue({
      success: false,
      reset: Date.now() + 60_000,
      remaining: 0,
      limit: 20,
    });
    const { POST } = await import('@/app/api/forge/voice/route');
    const audio = new Blob([new Uint8Array([1])], { type: 'audio/webm' });
    const res = await POST(makeMultipart(audio) as never, makeCtx({}));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
});
