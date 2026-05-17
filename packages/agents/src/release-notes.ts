/**
 * Pure helper that formats the Markdown release notes used in two places:
 *
 *  1. The body of the deploy-success email sent via Resend (PLAN.md §IV.4
 *     step 12).
 *  2. The `release_notes` column on the generated-agent Notion DB row
 *     (PLAN.md §IV.4 step 6 / the row attached to the worker via
 *     `ntn files create`).
 *
 * Why a pure formatter (instead of templating at the call site):
 *
 *  - Single source of truth for the release-notes surface; every channel that
 *    shows the message renders the exact same Markdown.
 *  - Easy to snapshot-test: same inputs always produce byte-identical output,
 *    so any future change to the wording is reviewable as a diff.
 *  - No dependency on the wider Shipper machinery — this file can be imported
 *    by the dashboard, the MCP server, or the eval harness without dragging
 *    in Prisma or `@vercel/blob`.
 *
 * Compatibility note: Notion and most email clients render CommonMark with
 * the GFM extensions for tables + autolinks. We stick to the
 * intersection-feature set (no tables, no task lists, no HTML) so the same
 * string renders consistently in both surfaces.
 */

import type { AgentPattern } from './types.js';

/**
 * Human-friendly label for each {@link AgentPattern}. Kept here (not in
 * `types.ts`) because this mapping is *presentational* — the agent pipeline
 * never uses these strings for decisions.
 */
const PATTERN_LABELS: Readonly<Record<AgentPattern, string>> = {
  'database-query': 'Database query',
  'webhook-trigger': 'Webhook trigger',
  'sync-source': 'Sync source',
  'external-api-call': 'External API call',
  'multi-step': 'Multi-step workflow',
};

/**
 * Input shape for {@link formatReleaseNotes}.
 *
 * Field semantics:
 *
 *  - `description` — the user's original prompt; quoted verbatim so they
 *    recognise their own ask.
 *  - `pattern` — the resolved {@link AgentPattern}. Rendered with its
 *    human-readable label.
 *  - `deployUrl` — required. The live URL the agent is reachable at.
 *  - `webhookUrl` — optional. Only included for `webhook-trigger` agents (and
 *    occasionally `multi-step` agents that expose a webhook tool).
 *  - `oauthRedirectUrl` — optional. Surfaced as a "Next step" callout when
 *    the agent needs the user to grant a third-party OAuth scope before it
 *    can run end-to-end.
 *  - `sourceLines` — line count of the generated TypeScript. Purely for
 *    transparency ("we wrote 87 lines on your behalf"); a non-negative
 *    integer.
 */
export interface FormatReleaseNotesArgs {
  description: string;
  pattern: AgentPattern;
  deployUrl: string;
  webhookUrl?: string | undefined;
  oauthRedirectUrl?: string | undefined;
  sourceLines: number;
}

/**
 * Trim trailing whitespace on each line and collapse runs of >2 blank lines.
 * Markdown renderers tolerate the input either way, but consistent output
 * keeps snapshot tests stable.
 */
function tidy(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => line.replace(/[\t ]+$/u, ''))
    .join('\n')
    .replaceAll(/\n{3,}/gu, '\n\n')
    .trim();
}

/**
 * Render release notes for a successful Shipper run.
 *
 * Output is plain Markdown — no HTML, no extension features. Single trailing
 * newline omitted (callers concatenate). Safe to embed in JSON because every
 * field is escaped naively (no user-supplied character is treated as
 * Markdown-meaningful beyond what a typical description would be).
 *
 * @returns Markdown string. Always non-empty.
 */
export function formatReleaseNotes(args: FormatReleaseNotesArgs): string {
  const patternLabel = PATTERN_LABELS[args.pattern];
  const trimmedDescription = args.description.trim();
  const safeLines = Number.isFinite(args.sourceLines) ? Math.max(0, Math.trunc(args.sourceLines)) : 0;

  const lines: string[] = [
    '# Your new Notion agent is live',
    '',
    `**Pattern:** ${patternLabel}`,
    `**Source size:** ${safeLines} line${safeLines === 1 ? '' : 's'} of TypeScript`,
    `**Deploy URL:** [${args.deployUrl}](${args.deployUrl})`,
  ];

  if (args.webhookUrl !== undefined && args.webhookUrl.length > 0) {
    lines.push(`**Webhook URL:** \`${args.webhookUrl}\``);
  }

  lines.push('', '## What you asked for', '', `> ${trimmedDescription.length === 0 ? '(no description provided)' : trimmedDescription}`);

  if (args.oauthRedirectUrl !== undefined && args.oauthRedirectUrl.length > 0) {
    lines.push(
      '',
      '## Next step — grant access',
      '',
      `This agent needs you to complete a one-time OAuth authorization. Open the link below to finish wiring it up:`,
      '',
      `[Grant access](${args.oauthRedirectUrl})`,
    );
  }

  lines.push(
    '',
    '## How to invoke it',
    '',
    `Open any Notion Custom Agent chat in your workspace and your new tool will appear in the agent's toolbelt. You can also call it directly via the deploy URL above.`,
  );

  return tidy(lines.join('\n'));
}
