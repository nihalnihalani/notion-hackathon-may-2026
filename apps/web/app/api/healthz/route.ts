/**
 * GET /api/healthz — liveness + dependency health.
 *
 * Public (no auth). Returns 200 always so external uptime monitors don't
 * page on a single dependency hiccup; the `status` field distinguishes
 * `ok` from `degraded`. Use `checks[*].ok` for per-dependency alerting.
 *
 * Checks performed (each capped at 1.5s):
 *   - PlanetScale Postgres   → `SELECT 1`
 *   - Upstash Redis          → `PING`
 *   - Notion API             → unauthenticated `GET /v1/oauth/token` —
 *                              returns a 4xx but PROVES Notion is up; only
 *                              a network/DNS failure means "down".
 */

import { NextResponse } from 'next/server';
import { prisma } from '@forge/db';
import { Redis } from '@upstash/redis';

import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CheckResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

interface HealthBody {
  status: 'ok' | 'degraded';
  checks: Record<string, CheckResult>;
  version: string;
  timestamp: string;
}

const TIMEOUT_MS = 1_500;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms),
    ),
  ]);
}

async function checkDatabase(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, TIMEOUT_MS);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : 'unknown',
    };
  }
}

async function checkRedis(): Promise<CheckResult> {
  const t0 = Date.now();
  const url = process.env['UPSTASH_REDIS_REST_URL'];
  const token = process.env['UPSTASH_REDIS_REST_TOKEN'];
  if (!url || !token) {
    return { ok: false, latencyMs: 0, error: 'upstash_not_configured' };
  }
  try {
    const redis = new Redis({ url, token });
    await withTimeout(redis.ping(), TIMEOUT_MS);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : 'unknown',
    };
  }
}

/**
 * Ping the Notion API without a workspace token. `GET /v1/oauth/token`
 * 405s (or 4xx) when unauthenticated — that's the success signal we want.
 * Notion answering AT ALL means the upstream is reachable; only a network
 * error / DNS failure / timeout counts as "down".
 *
 * Uses the public OAuth client id/secret so we don't depend on a workspace
 * access token being available in the healthz handler's context. Sending an
 * empty body to a JSON endpoint also returns a 4xx, never a 5xx-from-us.
 */
async function checkNotion(): Promise<CheckResult> {
  const t0 = Date.now();
  const clientId = process.env['NOTION_OAUTH_CLIENT_ID'];
  const clientSecret = process.env['NOTION_OAUTH_CLIENT_SECRET'];
  if (!clientId || !clientSecret) {
    return { ok: false, latencyMs: 0, error: 'notion_oauth_not_configured' };
  }
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    'base64',
  );
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch('https://api.notion.com/v1/oauth/token', {
        method: 'GET',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Notion-Version': '2025-09-03',
        },
        signal: controller.signal,
      });
      // Any HTTP status ≤ 599 means Notion answered. 4xx is expected here
      // because `GET` on the token endpoint is not authenticated for issue.
      return {
        ok: res.status <= 599,
        latencyMs: Date.now() - t0,
        ...(res.status >= 500 && { error: `http_${res.status}` }),
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // AbortError (timeout) or DNS/network failure → genuinely down.
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : 'unknown',
    };
  }
}

export const GET = withSentry(
  async () => {
    const [db, redis, notion] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkNotion(),
    ]);
    const body: HealthBody = {
      status: db.ok && redis.ok && notion.ok ? 'ok' : 'degraded',
      checks: { database: db, redis, notion },
      version: process.env['VERCEL_GIT_COMMIT_SHA'] ?? 'dev',
      timestamp: new Date().toISOString(),
    };
    // Status code is always 200 — see route comment.
    return NextResponse.json(body, { status: 200 });
  },
  { routeName: 'healthz' },
);
