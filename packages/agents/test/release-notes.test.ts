/**
 * Tests for {@link formatReleaseNotes}.
 *
 * The function is pure Markdown formatting. Assertions focus on:
 *  - Required headings + sections are present.
 *  - Optional sections (OAuth + webhook) appear only when their inputs do.
 *  - Edge cases (empty description, plural / singular line count) render
 *    cleanly.
 *  - The output is stable across reformatting (no trailing whitespace, no
 *    runs of 3+ blank lines).
 */

import { describe, expect, it } from 'vitest';
import { formatReleaseNotes } from '../src/release-notes.js';

describe('formatReleaseNotes', () => {
  it('renders the required headings and pattern label', () => {
    const md = formatReleaseNotes({
      description: 'Triage incoming bugs.',
      pattern: 'database-query',
      deployUrl: 'https://my-agent.notion.app/agent',
      sourceLines: 87,
    });
    expect(md).toContain('# Your new Notion agent is live');
    expect(md).toContain('**Pattern:** Database query');
    expect(md).toContain('## What you asked for');
    expect(md).toContain('## How to invoke it');
    expect(md).toContain('https://my-agent.notion.app/agent');
  });

  it('uses singular "line" when sourceLines === 1', () => {
    const md = formatReleaseNotes({
      description: 'x',
      pattern: 'multi-step',
      deployUrl: 'https://a',
      sourceLines: 1,
    });
    expect(md).toContain('1 line of TypeScript');
    expect(md).not.toContain('1 lines');
  });

  it('uses plural "lines" otherwise (incl. zero)', () => {
    expect(
      formatReleaseNotes({
        description: 'x',
        pattern: 'multi-step',
        deployUrl: 'https://a',
        sourceLines: 0,
      }),
    ).toContain('0 lines of TypeScript');
    expect(
      formatReleaseNotes({
        description: 'x',
        pattern: 'multi-step',
        deployUrl: 'https://a',
        sourceLines: 87,
      }),
    ).toContain('87 lines of TypeScript');
  });

  it('omits the webhook section when no webhookUrl is supplied', () => {
    const md = formatReleaseNotes({
      description: 'd',
      pattern: 'database-query',
      deployUrl: 'https://a',
      sourceLines: 10,
    });
    expect(md).not.toContain('Webhook URL');
  });

  it('includes the webhook section when webhookUrl is non-empty', () => {
    const md = formatReleaseNotes({
      description: 'd',
      pattern: 'webhook-trigger',
      deployUrl: 'https://a',
      webhookUrl: 'https://hooks.notion.so/abc',
      sourceLines: 10,
    });
    expect(md).toContain('**Webhook URL:** `https://hooks.notion.so/abc`');
  });

  it('omits the webhook section when webhookUrl is an empty string', () => {
    const md = formatReleaseNotes({
      description: 'd',
      pattern: 'webhook-trigger',
      deployUrl: 'https://a',
      webhookUrl: '',
      sourceLines: 10,
    });
    expect(md).not.toContain('Webhook URL');
  });

  it('includes the OAuth "Next step" section when oauthRedirectUrl is set', () => {
    const md = formatReleaseNotes({
      description: 'd',
      pattern: 'external-api-call',
      deployUrl: 'https://a',
      oauthRedirectUrl: 'https://github.com/login/oauth/authorize?...',
      sourceLines: 10,
    });
    expect(md).toContain('## Next step — grant access');
    expect(md).toContain('[Grant access](https://github.com/login/oauth/authorize?...)');
  });

  it('omits the OAuth section when oauthRedirectUrl is absent or empty', () => {
    const md = formatReleaseNotes({
      description: 'd',
      pattern: 'database-query',
      deployUrl: 'https://a',
      sourceLines: 10,
    });
    expect(md).not.toContain('## Next step');
    const md2 = formatReleaseNotes({
      description: 'd',
      pattern: 'database-query',
      deployUrl: 'https://a',
      oauthRedirectUrl: '',
      sourceLines: 10,
    });
    expect(md2).not.toContain('## Next step');
  });

  it('handles every pattern label without crashing', () => {
    const patterns = [
      'database-query',
      'webhook-trigger',
      'sync-source',
      'external-api-call',
      'multi-step',
    ] as const;
    for (const p of patterns) {
      const md = formatReleaseNotes({
        description: 'd',
        pattern: p,
        deployUrl: 'https://a',
        sourceLines: 1,
      });
      expect(md).toMatch(/\*\*Pattern:\*\* [A-Z]/u);
    }
  });

  it('handles an empty description with a placeholder', () => {
    const md = formatReleaseNotes({
      description: '   ',
      pattern: 'database-query',
      deployUrl: 'https://a',
      sourceLines: 0,
    });
    expect(md).toContain('(no description provided)');
  });

  it('produces output with no trailing whitespace or triple newlines', () => {
    const md = formatReleaseNotes({
      description: 'd',
      pattern: 'database-query',
      deployUrl: 'https://a',
      oauthRedirectUrl: 'https://oauth',
      webhookUrl: 'https://hook',
      sourceLines: 10,
    });
    for (const line of md.split('\n')) {
      expect(line).toBe(line.replace(/[\t ]+$/u, ''));
    }
    expect(md).not.toMatch(/\n{3,}/u);
  });

  it('is deterministic (same inputs → same output)', () => {
    const args = {
      description: 'sync open PRs into Notion',
      pattern: 'sync-source' as const,
      deployUrl: 'https://a.notion.app/agent',
      sourceLines: 42,
    };
    expect(formatReleaseNotes(args)).toBe(formatReleaseNotes(args));
  });

  it('rounds non-integer sourceLines to a clean integer', () => {
    const md = formatReleaseNotes({
      description: 'd',
      pattern: 'database-query',
      deployUrl: 'https://a',
      sourceLines: 12.9,
    });
    expect(md).toContain('12 lines');
  });

  it('clamps negative sourceLines to 0', () => {
    const md = formatReleaseNotes({
      description: 'd',
      pattern: 'database-query',
      deployUrl: 'https://a',
      sourceLines: -5,
    });
    expect(md).toContain('0 lines');
  });
});
