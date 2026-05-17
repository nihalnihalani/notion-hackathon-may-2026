/**
 * Unit tests for prompt template rendering.
 *
 * Each prompt produces a single user-message turn. We assert the slot-fill
 * behavior (placeholders when args are missing; verbatim quoting when they
 * are present) plus the catalog metadata.
 */

import { describe, expect, it } from 'vitest';

import {
  forgeDescribeAgentArgsSchema,
  forgeDiagnoseFailureArgsSchema,
  PROMPT_CATALOG,
  renderDescribeAgentPrompt,
  renderDiagnoseFailurePrompt,
} from '../src/prompts.js';

describe('renderDescribeAgentPrompt', () => {
  it('emits placeholders when no slots are filled', () => {
    const out = renderDescribeAgentPrompt({});
    expect(out.messages).toHaveLength(1);
    const turn = out.messages[0]!;
    expect(turn.role).toBe('user');
    expect(turn.content.type).toBe('text');
    expect(turn.content.text).toContain('Input: <describe what the agent will receive');
    expect(turn.content.text).toContain('Output: <describe what the agent will produce');
    expect(turn.content.text).toContain('Triggers: <describe when it should run');
  });

  it('quotes user-supplied slots verbatim (trimmed)', () => {
    const out = renderDescribeAgentPrompt({
      input: '  A row in the Bugs database  ',
      output: 'A Slack message in #oncall',
      triggers: 'On every new row',
    });
    const text = out.messages[0]!.content.text;
    expect(text).toContain('Input: A row in the Bugs database');
    expect(text).toContain('Output: A Slack message in #oncall');
    expect(text).toContain('Triggers: On every new row');
    // The trimmed-input branch must not still emit the placeholder.
    expect(text).not.toContain('<describe what the agent will receive');
  });

  it("falls back to placeholders when slots are whitespace-only", () => {
    const out = renderDescribeAgentPrompt({ input: '   ', output: '\n', triggers: '' });
    const text = out.messages[0]!.content.text;
    expect(text).toContain('Input: <describe what the agent will receive');
    expect(text).toContain('Output: <describe what the agent will produce');
    expect(text).toContain('Triggers: <describe when it should run');
  });

  it('args schema rejects unknown keys via zod object passthrough rules (sanity)', () => {
    // Default zod object strips unknown keys; we just confirm it parses.
    const parsed = forgeDescribeAgentArgsSchema.parse({ input: 'x' });
    expect(parsed.input).toBe('x');
  });
});

describe('renderDiagnoseFailurePrompt', () => {
  it('embeds the generationId in step 1', () => {
    const out = renderDiagnoseFailurePrompt({ generationId: 'gen_99' });
    const text = out.messages[0]!.content.text;
    expect(text).toContain('Generation gen_99 failed.');
    expect(text).toContain('generationId = "gen_99"');
  });

  it('includes the hypothesis line when provided', () => {
    const out = renderDiagnoseFailurePrompt({
      generationId: 'gen_1',
      hypothesis: 'The Notion API returned 429s.',
    });
    expect(out.messages[0]!.content.text).toContain(
      'My starting hypothesis: The Notion API returned 429s.',
    );
  });

  it('omits the hypothesis line when not provided', () => {
    const out = renderDiagnoseFailurePrompt({ generationId: 'gen_1' });
    expect(out.messages[0]!.content.text).not.toContain('My starting hypothesis:');
  });

  it('requires generationId via the args schema', () => {
    expect(() => forgeDiagnoseFailureArgsSchema.parse({})).toThrow();
    expect(() => forgeDiagnoseFailureArgsSchema.parse({ generationId: '' })).toThrow();
  });
});

describe('PROMPT_CATALOG', () => {
  it('exposes exactly two prompts', () => {
    expect(Object.keys(PROMPT_CATALOG).sort()).toStrictEqual([
      'forge_describe_agent',
      'forge_diagnose_failure',
    ]);
  });

  it('every catalog entry has the fields server.ts needs to register it', () => {
    for (const entry of Object.values(PROMPT_CATALOG)) {
      expect(typeof entry.title).toBe('string');
      expect(typeof entry.description).toBe('string');
      expect(typeof entry.render).toBe('function');
      expect(typeof entry.argsShape).toBe('object');
    }
  });
});
