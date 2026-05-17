/**
 * Webhook signature verification tests.
 *
 * Generates known-good signatures with the SAME Web Crypto primitive the
 * library uses, then asserts:
 *  - valid signature → { valid: true }
 *  - tampered body → { valid: false, reason: 'signature_mismatch' }
 *  - wrong secret → { valid: false, reason: 'signature_mismatch' }
 *  - missing header → { valid: false, reason: 'missing_signature_header' }
 *  - malformed prefix → { valid: false, reason: 'invalid_signature_format' }
 *  - non-hex digest → { valid: false, reason: 'invalid_signature_encoding' }
 *  - constant-time-equal sanity
 */

import { describe, expect, it } from 'vitest';
import {
  verifyNotionWebhookSignature,
  __test,
} from '../src/webhooks.js';

const SECRET = 'verification_token_test_abcdef';
const BODY = JSON.stringify({ type: 'page.created', data: { id: 'p1' } });

async function goodSig(body: string, secret = SECRET): Promise<string> {
  return `sha256=${await __test.hmacSha256Hex(secret, body)}`;
}

describe('verifyNotionWebhookSignature', () => {
  it('accepts a correctly-signed payload', async () => {
    const sig = await goodSig(BODY);
    const result = await verifyNotionWebhookSignature({
      rawBody: BODY,
      headers: { 'X-Notion-Signature': sig },
      secret: SECRET,
    });
    expect(result.valid).toBe(true);
  });

  it('accepts case-insensitive header lookup (plain record)', async () => {
    const sig = await goodSig(BODY);
    const result = await verifyNotionWebhookSignature({
      rawBody: BODY,
      headers: { 'x-notion-SIGNATURE': sig },
      secret: SECRET,
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a Headers instance', async () => {
    const sig = await goodSig(BODY);
    const h = new Headers();
    h.set('X-Notion-Signature', sig);
    const result = await verifyNotionWebhookSignature({
      rawBody: BODY,
      headers: h,
      secret: SECRET,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const sig = await goodSig(BODY);
    const result = await verifyNotionWebhookSignature({
      rawBody: BODY + ' ',
      headers: { 'x-notion-signature': sig },
      secret: SECRET,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('rejects when signed with a different secret', async () => {
    const sig = await goodSig(BODY, 'attacker_secret');
    const result = await verifyNotionWebhookSignature({
      rawBody: BODY,
      headers: { 'x-notion-signature': sig },
      secret: SECRET,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('rejects missing header', async () => {
    const result = await verifyNotionWebhookSignature({
      rawBody: BODY,
      headers: {},
      secret: SECRET,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_signature_header');
  });

  it('rejects missing secret without leaking timing of HMAC', async () => {
    const result = await verifyNotionWebhookSignature({
      rawBody: BODY,
      headers: { 'x-notion-signature': 'sha256=deadbeef' },
      secret: '',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_secret');
  });

  it('rejects malformed prefix', async () => {
    const result = await verifyNotionWebhookSignature({
      rawBody: BODY,
      headers: { 'x-notion-signature': 'md5=abcd' },
      secret: SECRET,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature_format');
  });

  it('rejects non-hex digest', async () => {
    const result = await verifyNotionWebhookSignature({
      rawBody: BODY,
      headers: {
        'x-notion-signature':
          'sha256=GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',
      },
      secret: SECRET,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature_encoding');
  });

  it('rejects wrong-length digest', async () => {
    const result = await verifyNotionWebhookSignature({
      rawBody: BODY,
      headers: { 'x-notion-signature': 'sha256=abcd' },
      secret: SECRET,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature_encoding');
  });

  it('accepts upper-case hex from the server', async () => {
    const sig = (await goodSig(BODY)).toUpperCase().replace('SHA256=', 'sha256=');
    const result = await verifyNotionWebhookSignature({
      rawBody: BODY,
      headers: { 'x-notion-signature': sig },
      secret: SECRET,
    });
    expect(result.valid).toBe(true);
  });

  describe('constantTimeEqual', () => {
    it('returns true for equal strings of any byte content', () => {
      expect(__test.constantTimeEqual('abc', 'abc')).toBe(true);
      expect(__test.constantTimeEqual('a'.repeat(64), 'a'.repeat(64))).toBe(true);
    });

    it('returns false for unequal-length strings', () => {
      expect(__test.constantTimeEqual('abc', 'abcd')).toBe(false);
    });

    it('returns false for same-length but differing strings', () => {
      expect(__test.constantTimeEqual('abc', 'abd')).toBe(false);
    });
  });
});
