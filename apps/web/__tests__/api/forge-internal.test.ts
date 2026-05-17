/**
 * Unit tests for the FORGE_INTERNAL_TOKEN validator (lib/forge-internal.ts).
 *
 * Validates:
 *   - missing env → false
 *   - placeholder env → false (must rotate before deploy)
 *   - good token → true
 *   - bad token  → false
 *   - missing/malformed header → false
 */

import { afterEach, describe, expect, it } from 'vitest';

import { validateForgeInternalToken } from '@/lib/forge-internal';

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/_', { headers });
}

afterEach(() => {
  delete process.env['FORGE_INTERNAL_TOKEN'];
});

describe('validateForgeInternalToken', () => {
  it('returns false when env is unset', () => {
    expect(validateForgeInternalToken(request({ authorization: 'Bearer x' }))).toBe(false);
  });

  it('returns false when env is the placeholder', () => {
    process.env['FORGE_INTERNAL_TOKEN'] = 'REPLACE_ME';
    expect(
      validateForgeInternalToken(request({ authorization: 'Bearer REPLACE_ME' })),
    ).toBe(false);
  });

  it('returns true on exact token match', () => {
    process.env['FORGE_INTERNAL_TOKEN'] = 'good-token-abc';
    expect(
      validateForgeInternalToken(request({ authorization: 'Bearer good-token-abc' })),
    ).toBe(true);
  });

  it('returns false on mismatch', () => {
    process.env['FORGE_INTERNAL_TOKEN'] = 'good-token-abc';
    expect(
      validateForgeInternalToken(request({ authorization: 'Bearer bad-token' })),
    ).toBe(false);
  });

  it('returns false without authorization header', () => {
    process.env['FORGE_INTERNAL_TOKEN'] = 'good';
    expect(validateForgeInternalToken(request())).toBe(false);
  });

  it('returns false on malformed header', () => {
    process.env['FORGE_INTERNAL_TOKEN'] = 'good';
    expect(
      validateForgeInternalToken(request({ authorization: 'Basic good' })),
    ).toBe(false);
  });
});
