/**
 * Prompt templates exposed via MCP.
 *
 * Prompts are text scaffolds clients can pull and pre-fill before sending
 * them to the model. The MCP spec's `prompts/get` response shape is:
 *
 *   { description, messages: [{ role: 'user'|'assistant', content: ... }] }
 *
 * We keep the renderers as pure functions so they can be unit-tested without
 * the MCP server and so the SDK callback in `server.ts` stays a one-liner.
 *
 * Both prompts intentionally produce a SINGLE user-message turn — they're
 * scaffolds for the user to send, not full transcripts.
 */

import { z } from 'zod';

// ───────────────────────────────────────────────────────────────────────────
// forge_describe_agent
// ───────────────────────────────────────────────────────────────────────────

/**
 * Helps a user write a high-quality `description` for `forge_agent`. The
 * three optional slots map to the three things Schema Smith infers
 * automatically when missing but performs much better with explicitly:
 *
 *   - input   — what the agent receives (a Notion page, a webhook, ...)
 *   - output  — what it produces (a comment, a row, a Slack message, ...)
 *   - triggers — when it should run (button click, schedule, page edit, ...)
 */
export const forgeDescribeAgentArgsShape = {
  input: z
    .string()
    .optional()
    .describe('What the agent receives. Example: "A Notion page in the Bugs DB".'),
  output: z
    .string()
    .optional()
    .describe('What the agent produces. Example: "A triaged label + assignee + Slack ping".'),
  triggers: z
    .string()
    .optional()
    .describe(
      'When it should run. Example: "On every new row in the Bugs DB" or "Cron daily at 9am".',
    ),
} as const;
export const forgeDescribeAgentArgsSchema = z.object(forgeDescribeAgentArgsShape);
export type ForgeDescribeAgentArgs = z.infer<typeof forgeDescribeAgentArgsSchema>;

const DESCRIBE_PROMPT_DESCRIPTION =
  'Scaffold a complete agent description that Forge can compile into a deployed Custom Agent.';

export function renderDescribeAgentPrompt(args: ForgeDescribeAgentArgs): {
  description: string;
  messages: { role: 'user'; content: { type: 'text'; text: string } }[];
} {
  const inputLine = args.input?.trim()
    ? args.input.trim()
    : '<describe what the agent will receive — a Notion page, a webhook payload, a row, etc.>';
  const outputLine = args.output?.trim()
    ? args.output.trim()
    : '<describe what the agent will produce — a comment, a row, a label, a Slack message, etc.>';
  const triggersLine = args.triggers?.trim()
    ? args.triggers.trim()
    : '<describe when it should run — button click, schedule, page edit, webhook, etc.>';

  const body = [
    'I want to forge a Notion Custom Agent. Use this template to flesh out the description, then call the `forge_agent` tool with the final description as a single paragraph.',
    '',
    `Input: ${inputLine}`,
    `Output: ${outputLine}`,
    `Triggers: ${triggersLine}`,
    '',
    'Required details before calling `forge_agent`:',
    '  1. Concrete data shape — what fields/columns/payload keys are involved?',
    '  2. Any external systems — Linear, GitHub, Slack, Stripe, plain HTTP?',
    '  3. Failure behavior — what should happen if the upstream API is down?',
    '',
    'When the description is complete, call `forge_agent` with `{ description: "<the full paragraph>" }`.',
  ].join('\n');

  return {
    description: DESCRIBE_PROMPT_DESCRIPTION,
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: body },
      },
    ],
  };
}

// ───────────────────────────────────────────────────────────────────────────
// forge_diagnose_failure
// ───────────────────────────────────────────────────────────────────────────

/**
 * A scaffold the user can use after `get_generation_status` returns
 * `status: 'failed'`. The single required `generationId` lets the prompt
 * embed the right id; the model is then asked to call
 * `get_generation_status` itself to pull the step trail.
 */
export const forgeDiagnoseFailureArgsShape = {
  generationId: z
    .string()
    .min(1)
    .describe('The id of the failed generation. Get this from `forge_agent`.'),
  hypothesis: z
    .string()
    .optional()
    .describe(
      'Optional starting hypothesis. Example: "The Notion API returned 429s".',
    ),
} as const;
export const forgeDiagnoseFailureArgsSchema = z.object(
  forgeDiagnoseFailureArgsShape,
);
export type ForgeDiagnoseFailureArgs = z.infer<
  typeof forgeDiagnoseFailureArgsSchema
>;

const DIAGNOSE_PROMPT_DESCRIPTION =
  'Walk through a failed generation step-by-step and surface the likely root cause.';

export function renderDiagnoseFailurePrompt(args: ForgeDiagnoseFailureArgs): {
  description: string;
  messages: { role: 'user'; content: { type: 'text'; text: string } }[];
} {
  const hypothesisBlock = args.hypothesis?.trim()
    ? `\nMy starting hypothesis: ${args.hypothesis.trim()}\n`
    : '';

  const body = [
    `Generation ${args.generationId} failed. Diagnose it.`,
    '',
    'Process:',
    `  1. Call \`get_generation_status\` with generationId = "${args.generationId}".`,
    '  2. For each step in the trail, note its status, errorJson, and latencyMs.',
    '  3. Identify the first step that did not succeed — that is almost always the root cause; later steps usually fail downstream of it.',
    '  4. If the failing step is `schema-smith`: the description was probably ambiguous; suggest specific wording to clarify.',
    '  5. If the failing step is `tool-coder`: the generated code did not compile / hit a runtime error; quote the relevant `errorJson.message`.',
    '  6. If the failing step is `inspector`: the synthetic-input run produced output that did not match the declared schema; quote the mismatched field.',
    '  7. If the failing step is `shipper`: deployment failed; check the upstream NTN error code.',
    hypothesisBlock,
    'Output:',
    '  - One-sentence root cause.',
    '  - The minimal fix the user should make (rewording, missing OAuth scope, etc.).',
    '  - Whether re-forging with `force: true` is likely to help.',
  ].join('\n');

  return {
    description: DIAGNOSE_PROMPT_DESCRIPTION,
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: body },
      },
    ],
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Catalog (consumed by server.ts to register each prompt with one loop)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Stable catalog of prompts. Keeping the metadata co-located with the
 * renderer means there's exactly one place to edit when a prompt evolves.
 */
export const PROMPT_CATALOG = {
  forge_describe_agent: {
    title: 'Describe an agent for Forge',
    description: DESCRIBE_PROMPT_DESCRIPTION,
    argsShape: forgeDescribeAgentArgsShape,
    render: renderDescribeAgentPrompt,
  },
  forge_diagnose_failure: {
    title: 'Diagnose a failed Forge generation',
    description: DIAGNOSE_PROMPT_DESCRIPTION,
    argsShape: forgeDiagnoseFailureArgsShape,
    render: renderDiagnoseFailurePrompt,
  },
} as const;

export type PromptName = keyof typeof PROMPT_CATALOG;
