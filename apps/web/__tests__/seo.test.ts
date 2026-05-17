/**
 * Tests for the App-Router SEO surfaces: robots.ts and sitemap.ts.
 *
 * These files are tiny but load-bearing — a malformed robots policy can
 * accidentally deindex the marketing site, and a missing sitemap means
 * Google crawls less efficiently. The tests pin:
 *
 *   - The crawl policy disallows every authed surface.
 *   - The crawl policy allows the marketing root.
 *   - The sitemap announces an absolute URL built from resolveAppUrl().
 *   - The sitemap includes the landing page at priority 1.0.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import robots from '../app/robots';
import sitemap from '../app/sitemap';

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

describe('robots.ts', () => {
  let snap: Record<string, string | undefined>;
  beforeEach(() => {
    snap = snapshotEnv();
    process.env['NEXT_PUBLIC_APP_URL'] = 'https://forge.test';
    delete process.env['VERCEL_URL'];
  });
  afterEach(() => restoreEnv(snap));

  it('allows the marketing root', () => {
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0]! : r.rules;
    expect(rule.allow).toBe('/');
  });

  it('disallows every authed surface and the API namespace', () => {
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0]! : r.rules;
    const disallow = (rule.disallow ?? []) as ReadonlyArray<string>;
    for (const expected of [
      '/api/',
      '/dashboard',
      '/agents',
      '/generations',
      '/evals',
      '/settings',
      '/onboarding',
    ]) {
      expect(disallow).toContain(expected);
    }
  });

  it('announces an absolute sitemap URL on the configured origin', () => {
    const r = robots();
    expect(r.sitemap).toBe('https://forge.test/sitemap.xml');
    expect(r.host).toBe('https://forge.test');
  });
});

describe('sitemap.ts', () => {
  let snap: Record<string, string | undefined>;
  beforeEach(() => {
    snap = snapshotEnv();
    process.env['NEXT_PUBLIC_APP_URL'] = 'https://forge.test';
    delete process.env['VERCEL_URL'];
  });
  afterEach(() => restoreEnv(snap));

  it('includes the marketing root with priority 1.0', () => {
    const entries = sitemap();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const root = entries.find((e) => e.url.endsWith('/'));
    expect(root).toBeDefined();
    expect(root!.url).toBe('https://forge.test/');
    expect(root!.priority).toBe(1.0);
    expect(root!.changeFrequency).toBe('weekly');
  });

  it('stamps a real Date on every entry', () => {
    for (const entry of sitemap()) {
      expect(entry.lastModified).toBeInstanceOf(Date);
    }
  });

  it('never emits authed routes', () => {
    const urls = sitemap().map((e) => e.url);
    for (const forbidden of [
      '/dashboard',
      '/agents',
      '/generations',
      '/evals',
      '/settings',
      '/onboarding',
      '/api',
    ]) {
      expect(urls.some((u) => u.includes(forbidden))).toBe(false);
    }
  });
});
