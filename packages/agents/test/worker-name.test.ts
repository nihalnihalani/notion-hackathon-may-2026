/**
 * Unit tests for the Worker-name helpers.
 *
 * Both functions are pure; we don't mock anything — just feed strings.
 */

import { describe, expect, it } from 'vitest';
import { deriveWorkerName, validateWorkerName } from '../src/worker-name.js';

describe('deriveWorkerName', () => {
  it('produces a deterministic name for identical input', () => {
    const a = deriveWorkerName('Pull my open Linear bugs and rank by severity');
    const b = deriveWorkerName('Pull my open Linear bugs and rank by severity');
    expect(a).toBe(b);
  });

  it('always starts with `forge-`', () => {
    expect(deriveWorkerName('hello').startsWith('forge-')).toBe(true);
    expect(deriveWorkerName('Anything').startsWith('forge-')).toBe(true);
  });

  it('caps total length at 63 characters', () => {
    const long = 'A very long description '.repeat(20);
    expect(deriveWorkerName(long).length).toBeLessThanOrEqual(63);
  });

  it('emits the format `forge-<slug>-<hash6>`', () => {
    const name = deriveWorkerName('Sync Sentry issues every 15min');
    expect(name).toMatch(/^forge-[a-z0-9-]{1,40}-[a-f0-9]{6}$/u);
  });

  it('falls back to `agent` slug when description has no alphanumerics', () => {
    const name = deriveWorkerName('!!! @@@ ###');
    expect(name).toMatch(/^forge-agent-[a-f0-9]{6}$/u);
  });

  it('produces different names for different inputs even when slugs collide', () => {
    // Both slugify to the same prefix, but the hash differentiates.
    const a = deriveWorkerName('Read Notion pages');
    const b = deriveWorkerName('READ NOTION PAGES.');
    // Lowercase identical text; case + trailing punctuation differ → SHA256 differs
    expect(a).not.toBe(b);
  });
});

describe('validateWorkerName', () => {
  it('accepts a freshly derived name', () => {
    const name = deriveWorkerName('Look up GitHub repo metadata');
    expect(validateWorkerName(name)).toBe(true);
  });

  it('rejects missing prefix', () => {
    expect(validateWorkerName('my-agent-abc123')).toBe(false);
  });

  it('rejects uppercase letters', () => {
    expect(validateWorkerName('forge-MyAgent-abc123')).toBe(false);
  });

  it('rejects oversized slugs', () => {
    const slug = 'a'.repeat(50);
    expect(validateWorkerName(`forge-${slug}-abc123`)).toBe(false);
  });

  it('rejects wrong-length hash', () => {
    expect(validateWorkerName('forge-test-abc12')).toBe(false);
    expect(validateWorkerName('forge-test-abc1234')).toBe(false);
  });
});
