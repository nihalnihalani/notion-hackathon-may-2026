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
 *
 * The Notion API ping is intentionally skipped here: it requires a workspace
 * token (we don't carry one), and Notion's own status page is already a
 * better signal for that dependency.
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

export const GET = withSentry(
  async () => {
    const [db, redis] = await Promise.all([checkDatabase(), checkRedis()]);
    const body: HealthBody = {
      status: db.ok && redis.ok ? 'ok' : 'degraded',
      checks: { database: db, redis },
      version: process.env['VERCEL_GIT_COMMIT_SHA'] ?? 'dev',
      timestamp: new Date().toISOString(),
    };
    // Status code is always 200 — see route comment.
    return NextResponse.json(body, { status: 200 });
  },
  { routeName: 'healthz' },
);
