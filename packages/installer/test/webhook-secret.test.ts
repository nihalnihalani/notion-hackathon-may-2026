import { describe, expect, it } from 'vitest';

import { generateWorkspaceWebhookSecret } from '../src/webhook-secret.js';

describe('generateWorkspaceWebhookSecret', () => {
  it('returns 64 hex characters (256 bits)', () => {
    const secret = generateWorkspaceWebhookSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a unique value each call (very high probability)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateWorkspaceWebhookSecret());
    expect(seen.size).toBe(100);
  });

  it('has full byte entropy (no all-zero or all-FF patterns)', () => {
    // Probabilistically impossible for crypto.getRandomValues to produce
    // 32 identical bytes; this guards against a regression that
    // swaps it for a deterministic generator.
    for (let i = 0; i < 5; i++) {
      const s = generateWorkspaceWebhookSecret();
      expect(s).not.toBe('0'.repeat(64));
      expect(s).not.toBe('f'.repeat(64));
    }
  });

  it('outputs lowercase hex (caller code matches case insensitively but we lock the format)', () => {
    const s = generateWorkspaceWebhookSecret();
    expect(s.toLowerCase()).toBe(s);
  });
});
