/**
 * Tests for `auth.ts` — `hasApiToken`, the `NOTION_API_TOKEN` short-circuit
 * in `isLoggedIn`, and the `loginInstructions` text.
 *
 * We deliberately do NOT spawn `ntn doctor` in any of these cases: the
 * `isLoggedIn({ env: { NOTION_API_TOKEN } })` path must avoid the subprocess
 * entirely, and to prove that we point `binary` at a path that does not
 * exist — any spawn would surface as `NtnNotInstalledError`, which is what
 * the failure assertions look for.
 */

import { describe, expect, it } from 'vitest';

import { hasApiToken, isLoggedIn, loginInstructions } from '../src/index';

describe('hasApiToken', () => {
  it('returns true for a non-empty string', () => {
    expect(hasApiToken({ NOTION_API_TOKEN: 'secret_abc' })).toBe(true);
  });

  it('returns false when the var is undefined', () => {
    expect(hasApiToken({})).toBe(false);
    expect(hasApiToken({ NOTION_API_TOKEN: undefined })).toBe(false);
  });

  it('returns false for an empty / whitespace-only string', () => {
    expect(hasApiToken({ NOTION_API_TOKEN: '' })).toBe(false);
    expect(hasApiToken({ NOTION_API_TOKEN: '   ' })).toBe(false);
  });

  it('ignores unrelated env keys', () => {
    expect(hasApiToken({ NOTION_OAUTH_CLIENT_ID: 'x' })).toBe(false);
  });
});

describe('isLoggedIn', () => {
  it('short-circuits to true when NOTION_API_TOKEN is set (no spawn)', async () => {
    // If isLoggedIn tried to spawn, the fake binary would ENOENT and the
    // function would `catch` -> return false. We get true iff the
    // short-circuit fires before runDoctor is called.
    const result = await isLoggedIn({
      env: { NOTION_API_TOKEN: 'secret_abc' },
      binary: '/nonexistent/path/to/ntn-binary-xyz',
      timeoutMs: 5_000,
    });
    expect(result).toBe(true);
  });

  it('does NOT short-circuit on empty NOTION_API_TOKEN', async () => {
    // Empty token -> falls through to runDoctor -> spawn ENOENT -> caught
    // -> returns false. This proves `hasApiToken` is the gate, not just
    // presence of the env var.
    const result = await isLoggedIn({
      env: { NOTION_API_TOKEN: '' },
      binary: '/nonexistent/path/to/ntn-binary-xyz',
      timeoutMs: 5_000,
    });
    expect(result).toBe(false);
  });

  it('returns false when the doctor call fails entirely', async () => {
    const result = await isLoggedIn({
      binary: '/nonexistent/path/to/ntn-binary-xyz',
      timeoutMs: 5_000,
    });
    expect(result).toBe(false);
  });
});

describe('loginInstructions', () => {
  it('mentions both NOTION_API_TOKEN and `ntn login` as auth options', () => {
    const text = loginInstructions();
    expect(text).toContain('NOTION_API_TOKEN');
    expect(text).toContain('ntn login');
  });

  it('lists the env-var path before the interactive flow', () => {
    const text = loginInstructions();
    const tokenIdx = text.indexOf('NOTION_API_TOKEN');
    const loginIdx = text.indexOf('ntn login');
    expect(tokenIdx).toBeGreaterThanOrEqual(0);
    expect(loginIdx).toBeGreaterThan(tokenIdx);
  });
});
