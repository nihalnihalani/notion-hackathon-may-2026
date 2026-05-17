/**
 * Pure tests for `resolveAppUrl` — the canonical origin resolver used by
 * robots.ts, sitemap.ts, and the root layout metadata. The resolver is the
 * single load-bearing piece of SEO config; if it returns the wrong origin,
 * every absolute URL we ship is wrong.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appUrlBase, resolveAppUrl } from '../lib/site-url';

const ENV_KEYS = ['NEXT_PUBLIC_APP_URL', 'VERCEL_URL'] as const;

function snapshotEnv() {
  return Object.fromEntries(
    ENV_KEYS.map((k) => [k, process.env[k]]),
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>;
}

function restoreEnv(snap: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

describe('resolveAppUrl', () => {
  let snap: Record<string, string | undefined>;
  beforeEach(() => {
    snap = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    restoreEnv(snap);
  });

  it('falls back to the documented placeholder when no env is set', () => {
    expect(resolveAppUrl()).toBe('https://forge.example.com');
  });

  it('prefers NEXT_PUBLIC_APP_URL when set', () => {
    process.env['NEXT_PUBLIC_APP_URL'] = 'https://forge.acme.com';
    expect(resolveAppUrl()).toBe('https://forge.acme.com');
  });

  it('strips a trailing slash from NEXT_PUBLIC_APP_URL', () => {
    process.env['NEXT_PUBLIC_APP_URL'] = 'https://forge.acme.com/';
    expect(resolveAppUrl()).toBe('https://forge.acme.com');
  });

  it('falls back to VERCEL_URL when public env is missing, adding https://', () => {
    process.env['VERCEL_URL'] = 'forge-pr-42.vercel.app';
    expect(resolveAppUrl()).toBe('https://forge-pr-42.vercel.app');
  });

  it('respects an already-qualified VERCEL_URL', () => {
    process.env['VERCEL_URL'] = 'https://forge-pr-42.vercel.app';
    expect(resolveAppUrl()).toBe('https://forge-pr-42.vercel.app');
  });

  it('public env wins over vercel-set env', () => {
    process.env['NEXT_PUBLIC_APP_URL'] = 'https://prod.forge.com';
    process.env['VERCEL_URL'] = 'preview.vercel.app';
    expect(resolveAppUrl()).toBe('https://prod.forge.com');
  });
});

describe('appUrlBase', () => {
  it('returns a URL object parsable as origin', () => {
    process.env['NEXT_PUBLIC_APP_URL'] = 'https://forge.test';
    const u = appUrlBase();
    expect(u).toBeInstanceOf(URL);
    expect(u.origin).toBe('https://forge.test');
  });
});
