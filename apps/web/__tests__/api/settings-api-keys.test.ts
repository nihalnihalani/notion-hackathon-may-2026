/**
 * /api/settings/api-keys
 *   GET    → 200 with `{ keys }` (no plaintext, no hash)
 *   POST   → 201 with `{ id, name, prefix, lastFour, key }`
 *   POST   → 400 on missing name/label
 *   DELETE → 204 on revoke (writes audit, flips revokedAt)
 *   DELETE → 404 when another user's key is targeted
 *   DELETE → 204 on a no-op double revoke
 *   401 on unauth across all methods
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCtx, makeRequest, readJson, stubSentryWrapper } from './_helpers';

stubSentryWrapper();

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
  clerkClient: vi.fn(),
}));

vi.mock('@forge/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userApiKey: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
  recordAuditEvent: vi.fn(),
}));

vi.mock('@/lib/posthog', () => ({ capture: vi.fn() }));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  limiters: { agentMutation: () => ({}) },
}));

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  const clerk = await import('@clerk/nextjs/server');
  vi.mocked(clerk.auth).mockResolvedValue({ userId: 'clerk_1' } as never);
  const db = await import('@forge/db');
  vi.mocked(db.prisma.user.findUnique).mockResolvedValue({
    id: 'user_1',
    clerkId: 'clerk_1',
    workspace: { id: 'ws_1', ownerUserId: 'clerk_1' },
  } as never);
  checkRateLimitMock.mockResolvedValue({
    success: true,
    reset: 0,
    remaining: 100,
    limit: 120,
  });
});

describe('GET /api/settings/api-keys', () => {
  it('returns the user keys without exposing the hash', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.userApiKey.findMany).mockResolvedValue([
      {
        id: 'k1',
        name: 'Laptop',
        prefix: 'forge_sk',
        lastFour: 'abcd',
        createdAt: new Date('2026-05-01T00:00:00Z'),
        lastUsedAt: null,
        revokedAt: null,
      },
    ] as never);
    const { GET } = await import('@/app/api/settings/api-keys/route');
    const res = await GET(
      makeRequest('http://localhost/api/settings/api-keys') as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{
      keys: ReadonlyArray<Record<string, unknown>>;
    }>(res);
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).not.toHaveProperty('hashedKey');
    expect(body.keys[0]).toMatchObject({
      id: 'k1',
      name: 'Laptop',
      prefix: 'forge_sk',
      lastFour: 'abcd',
      revoked: false,
    });
  });

  it('returns 401 without session', async () => {
    const clerk = await import('@clerk/nextjs/server');
    vi.mocked(clerk.auth).mockResolvedValue({ userId: null } as never);
    const { GET } = await import('@/app/api/settings/api-keys/route');
    const res = await GET(
      makeRequest('http://localhost/api/settings/api-keys') as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/settings/api-keys', () => {
  it('returns 201 with the full plaintext key on creation', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.userApiKey.create).mockResolvedValue({
      id: 'k1',
      name: 'Laptop',
      prefix: 'forge_sk',
      lastFour: 'wxyz',
      createdAt: new Date('2026-05-01T00:00:00Z'),
    } as never);
    const { POST } = await import('@/app/api/settings/api-keys/route');
    const res = await POST(
      makeRequest('http://localhost/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'Laptop' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(201);
    const body = await readJson<{ key: string; prefix: string; id: string }>(
      res,
    );
    expect(body.id).toBe('k1');
    expect(body.key).toMatch(/^forge_sk_/);
    expect(body.key.length).toBeGreaterThan(20);
    expect(db.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'api_key.created',
        metadata: expect.objectContaining({ keyId: 'k1', name: 'Laptop' }),
      }),
    );
  });

  it('accepts the legacy `label` field as a fallback for `name`', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.userApiKey.create).mockResolvedValue({
      id: 'k2',
      name: 'Laptop',
      prefix: 'forge_sk',
      lastFour: 'wxyz',
      createdAt: new Date('2026-05-01T00:00:00Z'),
    } as never);
    const { POST } = await import('@/app/api/settings/api-keys/route');
    const res = await POST(
      makeRequest('http://localhost/api/settings/api-keys', {
        method: 'POST',
        body: { label: 'Laptop' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(201);
  });

  it('returns 400 when neither name nor label is supplied', async () => {
    const { POST } = await import('@/app/api/settings/api-keys/route');
    const res = await POST(
      makeRequest('http://localhost/api/settings/api-keys', {
        method: 'POST',
        body: {},
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 without session', async () => {
    const clerk = await import('@clerk/nextjs/server');
    vi.mocked(clerk.auth).mockResolvedValue({ userId: null } as never);
    const { POST } = await import('@/app/api/settings/api-keys/route');
    const res = await POST(
      makeRequest('http://localhost/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'X' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/settings/api-keys/[id]', () => {
  it('returns 204 + flips revokedAt + writes audit on first revoke', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.userApiKey.findUnique).mockResolvedValue({
      id: 'k1',
      userId: 'user_1',
      revokedAt: null,
    } as never);
    vi.mocked(db.prisma.userApiKey.update).mockResolvedValue({} as never);

    const { DELETE } = await import('@/app/api/settings/api-keys/[id]/route');
    const res = await DELETE(
      makeRequest('http://localhost/api/settings/api-keys/k1', {
        method: 'DELETE',
      }) as never,
      makeCtx({ id: 'k1' }),
    );
    expect(res.status).toBe(204);
    expect(db.prisma.userApiKey.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { revokedAt: expect.any(Date) },
    });
    expect(db.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'api_key.revoked',
        metadata: { keyId: 'k1' },
      }),
    );
  });

  it('returns 204 without re-writing on a double revoke (idempotent)', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.userApiKey.findUnique).mockResolvedValue({
      id: 'k1',
      userId: 'user_1',
      revokedAt: new Date(),
    } as never);
    const { DELETE } = await import('@/app/api/settings/api-keys/[id]/route');
    const res = await DELETE(
      makeRequest('http://localhost/api/settings/api-keys/k1', {
        method: 'DELETE',
      }) as never,
      makeCtx({ id: 'k1' }),
    );
    expect(res.status).toBe(204);
    expect(db.prisma.userApiKey.update).not.toHaveBeenCalled();
    expect(db.recordAuditEvent).not.toHaveBeenCalled();
  });

  it('returns 404 when the key belongs to another user', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.userApiKey.findUnique).mockResolvedValue({
      id: 'k1',
      userId: 'someone_else',
      revokedAt: null,
    } as never);
    const { DELETE } = await import('@/app/api/settings/api-keys/[id]/route');
    const res = await DELETE(
      makeRequest('http://localhost/api/settings/api-keys/k1', {
        method: 'DELETE',
      }) as never,
      makeCtx({ id: 'k1' }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the key does not exist', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.userApiKey.findUnique).mockResolvedValue(null as never);
    const { DELETE } = await import('@/app/api/settings/api-keys/[id]/route');
    const res = await DELETE(
      makeRequest('http://localhost/api/settings/api-keys/ghost', {
        method: 'DELETE',
      }) as never,
      makeCtx({ id: 'ghost' }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 without session', async () => {
    const clerk = await import('@clerk/nextjs/server');
    vi.mocked(clerk.auth).mockResolvedValue({ userId: null } as never);
    const { DELETE } = await import('@/app/api/settings/api-keys/[id]/route');
    const res = await DELETE(
      makeRequest('http://localhost/api/settings/api-keys/k1', {
        method: 'DELETE',
      }) as never,
      makeCtx({ id: 'k1' }),
    );
    expect(res.status).toBe(401);
  });
});
