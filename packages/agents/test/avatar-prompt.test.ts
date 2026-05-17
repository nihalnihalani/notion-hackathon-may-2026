/**
 * Tests for {@link deriveAvatarPrompt}.
 *
 * The function is pure — every assertion is on the exact returned string.
 * We deliberately do NOT snapshot the whole prompt (that would couple the
 * test to wording tweaks that don't change semantics). Instead we assert on
 * the load-bearing invariants:
 *
 *  - The pattern-specific visual motif appears verbatim.
 *  - The description (after normalization) is spliced in.
 *  - Long descriptions are truncated with a trailing ellipsis.
 *  - Empty descriptions don't produce an empty prompt.
 *  - Internal whitespace in the description is collapsed (no embedded `\n`).
 *
 * These invariants are what downstream consumers (MiniMax + the dashboard's
 * avatar preview) actually care about.
 */

import { describe, expect, it } from 'vitest';
import { deriveAvatarPrompt } from '../src/avatar-prompt.js';
import type { AgentPattern } from '../src/types.js';

describe('deriveAvatarPrompt', () => {
  it('includes the database motif for database-query agents', () => {
    const out = deriveAvatarPrompt(
      'fetch all open bugs from the bug tracker',
      'database-query',
    );
    expect(out).toContain('database disks');
    expect(out).toContain('fetch all open bugs from the bug tracker');
  });

  it('includes the lightning motif for webhook-trigger agents', () => {
    const out = deriveAvatarPrompt('post Linear issues to Notion', 'webhook-trigger');
    expect(out).toContain('lightning bolt');
  });

  it('includes the looping arrows motif for sync-source agents', () => {
    const out = deriveAvatarPrompt('mirror GitHub PRs into Notion', 'sync-source');
    expect(out).toContain('circular arrows');
  });

  it('includes the hex socket motif for external-api-call agents', () => {
    const out = deriveAvatarPrompt('call the Stripe API', 'external-api-call');
    expect(out).toContain('hexagonal plug');
  });

  it('includes the flow chart motif for multi-step agents', () => {
    const out = deriveAvatarPrompt('triage incoming Sentry errors', 'multi-step');
    expect(out).toContain('flow chart');
  });

  it('falls back to a generic placeholder for empty descriptions', () => {
    const out = deriveAvatarPrompt('', 'database-query');
    expect(out).toContain('a helpful Notion agent');
    // The brand palette + size still appear.
    expect(out).toContain('soft purple');
    expect(out).toContain('512x512');
  });

  it('collapses internal whitespace in the description', () => {
    const messy = 'sync\n\nopen\tPRs    every\nhour';
    const out = deriveAvatarPrompt(messy, 'sync-source');
    expect(out).not.toContain('\n');
    expect(out).not.toContain('\t');
    expect(out).toContain('sync open PRs every hour');
  });

  it('truncates descriptions longer than the cap with an ellipsis', () => {
    const big = 'a '.repeat(300); // ~600 chars, way past the 240 cap
    const out = deriveAvatarPrompt(big, 'multi-step');
    // The truncated description appears with a trailing ellipsis (the
    // BMP horizontal ellipsis, NOT three dots).
    expect(out).toMatch(/a a a…/u);
    // The total prompt should not contain the full 600-char `a `-run.
    expect(out.length).toBeLessThan(700);
  });

  it('produces a deterministic prompt (same inputs → same output)', () => {
    const args: [string, AgentPattern] = ['describe my agent', 'database-query'];
    const a = deriveAvatarPrompt(...args);
    const b = deriveAvatarPrompt(...args);
    expect(a).toBe(b);
  });

  it('always mentions the brand palette + flat vector style', () => {
    for (const pattern of [
      'database-query',
      'webhook-trigger',
      'sync-source',
      'external-api-call',
      'multi-step',
    ] as const) {
      const out = deriveAvatarPrompt('x', pattern);
      expect(out).toContain('flat vector');
      expect(out).toContain('soft purple');
      expect(out).toContain('#A78BFA');
      expect(out).toContain('512x512');
    }
  });
});
