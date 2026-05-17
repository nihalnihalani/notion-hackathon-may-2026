/**
 * Few-shot examples for the Tool Coder system prompt.
 *
 * Eight hand-curated input → expected-output triples, one (or two) per
 * pattern. The {@link FEW_SHOT_EXAMPLES} array is spliced verbatim into
 * the Anthropic system prompt's cached prefix so the model sees
 * production-shaped code on every call.
 *
 * Hard requirements (verified by `test/templates.test.ts`):
 *
 *  - Every `expectedSource` parses with `@typescript-eslint/parser`.
 *  - Every `expectedSource` passes `@forge/safety/scan` against the
 *    default Notion network allowlist + a dep allowlist that includes
 *    `@notionhq/client`, `@notion/workers-sdk`, `@forge/connectors`,
 *    `zod`, `date-fns`.
 *  - Imports never reach outside the dep allowlist — no http(s), no
 *    axios, no `new URL(...)` literals targeting non-allowlisted hosts.
 *
 * Why hand-rolled (vs derived from templates): the few-shots have to
 * look like *good prose* the model will copy idiomatically. The
 * pattern-templates render mechanically-shaped code that's lossier as a
 * teaching example. We pay the maintenance cost (≈800 LOC of TS) to
 * raise generation quality.
 */

import type { SchemaSmithOutput } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shape
// ─────────────────────────────────────────────────────────────────────────────

export interface FewShotExample {
  /** The English description fed into Schema Smith → Tool Coder. */
  description: string;
  /** The (synthetic) Schema Smith output the example presumes. */
  schema: SchemaSmithOutput;
  /** The expected `src/index.ts` Tool Coder should produce. */
  expectedSource: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. database-query — "Pull my open Linear bugs and rank by severity"
// ─────────────────────────────────────────────────────────────────────────────

const FX_LINEAR_BUGS: FewShotExample = {
  description: "Pull my open Linear bugs and rank by severity",
  schema: {
    pattern: 'database-query',
    inputSchema: {
      kind: 'object',
      describe: 'Linear bug filter input',
      properties: {
        minSeverity: {
          kind: 'string',
          describe: 'Minimum severity (low|medium|high|urgent)',
          enum: ['low', 'medium', 'high', 'urgent'],
        },
      },
      required: ['minSeverity'],
    },
    outputSchema: {
      kind: 'array',
      describe: 'Open Linear bugs ranked by severity',
      items: {
        kind: 'object',
        describe: 'Linear bug',
        properties: {
          id: { kind: 'string', describe: 'Linear issue id' },
          title: { kind: 'string', describe: 'Issue title' },
          severity: { kind: 'string', describe: 'Severity bucket' },
          url: { kind: 'string', describe: 'Linear web URL' },
        },
        required: ['id', 'title', 'severity', 'url'],
      },
    },
    requiredScopes: [],
    requiredOAuth: ['linear'],
    rationale: 'Queries open Linear bugs and returns them sorted by severity.',
  },
  expectedSource: `/**
 * Pull my open Linear bugs and rank by severity.
 * Pattern: database-query
 */
import { worker, j } from '@notion/workers-sdk';
import { createLinearClient } from '@forge/connectors/linear';

const linear = createLinearClient({ apiKey: process.env['LINEAR_API_KEY'] ?? '' });

const SEVERITY_RANK: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1 };

worker.tool({
  name: 'open-linear-bugs',
  description: 'List open Linear bugs ranked by severity',
  input: j.object({
    minSeverity: j.string().enum(['low', 'medium', 'high', 'urgent']).describe('Minimum severity'),
  }).required(['minSeverity']).describe('Linear bug filter input'),
  output: j.array(
    j.object({
      id: j.string().describe('Linear issue id'),
      title: j.string().describe('Issue title'),
      severity: j.string().describe('Severity bucket'),
      url: j.string().describe('Linear web URL'),
    }).required(['id', 'title', 'severity', 'url']).describe('Linear bug'),
  ).describe('Open Linear bugs ranked by severity'),
  async handler(input) {
    try {
      const minRank = SEVERITY_RANK[input.minSeverity] ?? 1;
      const issues = await linear.listIssues({ state: 'open', label: 'bug' });
      const filtered = issues
        .map((i) => ({
          id: i.id,
          title: i.title,
          severity: i.priority ?? 'low',
          url: i.url,
        }))
        .filter((i) => (SEVERITY_RANK[i.severity] ?? 0) >= minRank)
        .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
      return { ok: true as const, results: filtered };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  },
});
`,
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. database-query — "Find Notion pages I've edited in the last 7 days"
// ─────────────────────────────────────────────────────────────────────────────

const FX_RECENT_NOTION_PAGES: FewShotExample = {
  description: "Find Notion pages I've edited in the last 7 days",
  schema: {
    pattern: 'database-query',
    inputSchema: {
      kind: 'object',
      describe: 'Recent-pages filter',
      properties: {
        databaseId: { kind: 'string', describe: 'Notion database id to query' },
        days: { kind: 'integer', describe: 'Lookback window in days (1-30)' },
      },
      required: ['databaseId'],
    },
    outputSchema: {
      kind: 'array',
      describe: 'Pages edited within the lookback window',
      items: {
        kind: 'object',
        describe: 'Page summary',
        properties: {
          id: { kind: 'string', describe: 'Page id' },
          lastEditedAt: { kind: 'datetime', describe: 'Last-edit timestamp' },
        },
        required: ['id', 'lastEditedAt'],
      },
    },
    requiredScopes: ['databases.read', 'pages.read'],
    requiredOAuth: [],
    rationale: 'Queries the Notion database filtered by last-edited within N days.',
  },
  expectedSource: `/**
 * Find Notion pages I've edited in the last 7 days.
 * Pattern: database-query
 */
import { worker, j } from '@notion/workers-sdk';
import { Client as NotionClient } from '@notionhq/client';
import { subDays, formatISO } from 'date-fns';

const notion = new NotionClient({ auth: process.env['NOTION_API_KEY'] ?? '' });

worker.tool({
  name: 'recent-notion-pages',
  description: 'List pages edited in the last N days',
  input: j.object({
    databaseId: j.string().describe('Notion database id'),
    days: j.integer().describe('Lookback window (1-30)'),
  }).required(['databaseId']).describe('Recent-pages filter'),
  output: j.array(
    j.object({
      id: j.string().describe('Page id'),
      lastEditedAt: j.datetime().describe('Last-edit timestamp'),
    }).required(['id', 'lastEditedAt']).describe('Page summary'),
  ).describe('Pages edited within window'),
  async handler(input) {
    try {
      const days = Math.min(Math.max(input.days ?? 7, 1), 30);
      const cutoff = formatISO(subDays(new Date(), days));
      const res = await notion.databases.query({
        database_id: input.databaseId,
        filter: {
          timestamp: 'last_edited_time',
          last_edited_time: { on_or_after: cutoff },
        },
        page_size: 100,
      });
      const results = res.results
        .filter((p): p is { id: string; last_edited_time: string } =>
          typeof (p as { last_edited_time?: unknown }).last_edited_time === 'string',
        )
        .map((p) => ({ id: p.id, lastEditedAt: p.last_edited_time }));
      return { ok: true as const, results };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  },
});
`,
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. webhook-trigger — "When a GitHub PR merges, draft a release note"
// ─────────────────────────────────────────────────────────────────────────────

const FX_GITHUB_PR_RELEASE_NOTE: FewShotExample = {
  description: 'When a GitHub PR merges, create a release-note draft in this database',
  schema: {
    pattern: 'webhook-trigger',
    inputSchema: {
      kind: 'object',
      describe: 'GitHub pull_request webhook payload (merged event)',
      properties: {
        action: { kind: 'string', describe: 'GitHub action name' },
        number: { kind: 'integer', describe: 'PR number' },
        title: { kind: 'string', describe: 'PR title' },
        merged: { kind: 'boolean', describe: 'Whether the PR was merged' },
        url: { kind: 'string', describe: 'PR html_url' },
      },
      required: ['action', 'number', 'title', 'merged', 'url'],
    },
    outputSchema: {
      kind: 'object',
      describe: 'Outcome',
      properties: {
        pageId: { kind: 'string', describe: 'Notion page id of the draft', nullable: true },
        skipped: { kind: 'boolean', describe: 'True when the PR was not actually merged' },
      },
      required: ['skipped'],
    },
    requiredScopes: ['pages.write', 'databases.read'],
    requiredOAuth: ['github'],
    rationale: 'Subscribes to GitHub pull_request webhooks and writes a release-note row.',
  },
  expectedSource: `/**
 * When a GitHub PR merges, create a release-note draft in this database.
 * Pattern: webhook-trigger
 */
import { worker, j } from '@notion/workers-sdk';
import { Client as NotionClient } from '@notionhq/client';
import { createGithubClient } from '@forge/connectors/github';

const notion = new NotionClient({ auth: process.env['NOTION_API_KEY'] ?? '' });
const github = createGithubClient({ apiKey: process.env['GITHUB_TOKEN'] ?? '' });

void (() => [github])();

worker.webhook({
  name: 'github-pr-release-note',
  description: 'Draft a release note when a PR merges',
  input: j.object({
    action: j.string().describe('GitHub action name'),
    number: j.integer().describe('PR number'),
    title: j.string().describe('PR title'),
    merged: j.boolean().describe('Whether the PR was merged'),
    url: j.string().describe('PR html_url'),
  }).required(['action', 'number', 'title', 'merged', 'url']).describe('GitHub PR webhook'),
  output: j.object({
    pageId: j.string().nullable().describe('Notion page id'),
    skipped: j.boolean().describe('True when not merged'),
  }).required(['skipped']).describe('Outcome'),
  async handler(event) {
    try {
      if (!event.merged) {
        return { ok: true as const, skipped: true, pageId: null };
      }
      const dbId = process.env['NOTION_DATABASE_ID'] ?? '';
      if (dbId.length === 0) {
        return { ok: false as const, error: 'NOTION_DATABASE_ID missing' };
      }
      const page = await notion.pages.create({
        parent: { database_id: dbId },
        properties: {
          Name: { title: [{ text: { content: 'PR #' + String(event.number) + ': ' + event.title } }] },
          URL: { url: event.url },
          Status: { select: { name: 'Draft' } },
        } as never,
      });
      return { ok: true as const, skipped: false, pageId: page.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  },
});
`,
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. webhook-trigger — "When Stripe charges, log to this database"
// ─────────────────────────────────────────────────────────────────────────────

const FX_STRIPE_CHARGE: FewShotExample = {
  description: 'When Stripe charges, log to this database',
  schema: {
    pattern: 'webhook-trigger',
    inputSchema: {
      kind: 'object',
      describe: 'Stripe charge.succeeded webhook payload',
      properties: {
        id: { kind: 'string', describe: 'Stripe charge id' },
        amount: { kind: 'integer', describe: 'Amount in smallest currency unit' },
        currency: { kind: 'string', describe: 'ISO currency code' },
        customer: { kind: 'string', describe: 'Stripe customer id', nullable: true },
        status: { kind: 'string', describe: 'Charge status' },
      },
      required: ['id', 'amount', 'currency', 'status'],
    },
    outputSchema: {
      kind: 'object',
      describe: 'Outcome',
      properties: {
        pageId: { kind: 'string', describe: 'Created Notion page id' },
      },
      required: ['pageId'],
    },
    requiredScopes: ['pages.write', 'databases.read'],
    requiredOAuth: ['stripe'],
    rationale: 'Subscribes to Stripe charge.succeeded events and logs to Notion.',
  },
  expectedSource: `/**
 * When Stripe charges, log to this database.
 * Pattern: webhook-trigger
 */
import { worker, j } from '@notion/workers-sdk';
import { Client as NotionClient } from '@notionhq/client';
import { createStripeClient } from '@forge/connectors/stripe';

const notion = new NotionClient({ auth: process.env['NOTION_API_KEY'] ?? '' });
const stripe = createStripeClient({ apiKey: process.env['STRIPE_API_KEY'] ?? '' });

void (() => [stripe])();

worker.webhook({
  name: 'stripe-charge-log',
  description: 'Log every successful Stripe charge to Notion',
  input: j.object({
    id: j.string().describe('Stripe charge id'),
    amount: j.integer().describe('Amount in smallest unit'),
    currency: j.string().describe('ISO currency'),
    customer: j.string().nullable().describe('Stripe customer id'),
    status: j.string().describe('Charge status'),
  }).required(['id', 'amount', 'currency', 'status']).describe('Stripe charge payload'),
  output: j.object({
    pageId: j.string().describe('Created Notion page id'),
  }).required(['pageId']).describe('Outcome'),
  async handler(event) {
    try {
      const dbId = process.env['NOTION_DATABASE_ID'] ?? '';
      if (dbId.length === 0) {
        return { ok: false as const, error: 'NOTION_DATABASE_ID missing' };
      }
      const page = await notion.pages.create({
        parent: { database_id: dbId },
        properties: {
          Name: { title: [{ text: { content: event.id } }] },
          Amount: { number: event.amount / 100 },
          Currency: { rich_text: [{ text: { content: event.currency } }] },
          Status: { select: { name: event.status } },
        } as never,
      });
      return { ok: true as const, pageId: page.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  },
});
`,
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. sync-source — "Every hour, pull Vercel deployments into a database"
// ─────────────────────────────────────────────────────────────────────────────

const FX_VERCEL_DEPLOYMENTS: FewShotExample = {
  description: 'Every hour, pull my Vercel deployments into a database',
  schema: {
    pattern: 'sync-source',
    inputSchema: {
      kind: 'object',
      describe: 'Sync tick input (empty — schedule-driven)',
      properties: {},
    },
    outputSchema: {
      kind: 'object',
      describe: 'Sync result',
      properties: {
        upserted: { kind: 'integer', describe: 'Rows upserted this tick' },
        cursor: { kind: 'string', describe: 'Pagination cursor for next tick', nullable: true },
      },
      required: ['upserted'],
    },
    requiredScopes: ['databases.write'],
    requiredOAuth: ['vercel'],
    rationale: 'Polls Vercel deployments hourly and upserts into the Notion database.',
  },
  expectedSource: `/**
 * Every hour, pull my Vercel deployments into a database.
 * Pattern: sync-source
 */
import { worker, j } from '@notion/workers-sdk';
import { Client as NotionClient } from '@notionhq/client';
import { createVercelClient } from '@forge/connectors/vercel';

const notion = new NotionClient({ auth: process.env['NOTION_API_KEY'] ?? '' });
const vercel = createVercelClient({ apiKey: process.env['VERCEL_API_TOKEN'] ?? '' });

worker.sync({
  name: 'vercel-deployments-sync',
  description: 'Hourly sync of Vercel deployments to Notion',
  input: j.object({}).describe('Sync tick input'),
  output: j.object({
    upserted: j.integer().describe('Rows upserted this tick'),
    cursor: j.string().nullable().describe('Pagination cursor for next tick'),
  }).required(['upserted']).describe('Sync result'),
  async handler(_input, ctx: { cursor: string | null }) {
    const dbId = process.env['NOTION_DATABASE_ID'] ?? '';
    if (dbId.length === 0) {
      return { ok: false as const, error: 'NOTION_DATABASE_ID missing', cursor: ctx.cursor };
    }
    try {
      const page = await vercel.listDeployments({ limit: 50, cursor: ctx.cursor ?? undefined });
      let upserted = 0;
      for (const dep of page.deployments) {
        await notion.pages.create({
          parent: { database_id: dbId },
          properties: {
            Name: { title: [{ text: { content: dep.url ?? dep.uid } }] },
            State: { select: { name: dep.state ?? 'unknown' } },
          } as never,
        });
        upserted += 1;
      }
      return { ok: true as const, upserted, cursor: page.nextCursor ?? null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message, cursor: ctx.cursor };
    }
  },
});
`,
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. sync-source — "Sync Sentry issues every 15min"
// ─────────────────────────────────────────────────────────────────────────────

const FX_SENTRY_ISSUES: FewShotExample = {
  description: 'Sync Sentry issues every 15min',
  schema: {
    pattern: 'sync-source',
    inputSchema: {
      kind: 'object',
      describe: 'Sentry sync tick input',
      properties: {
        organization: { kind: 'string', describe: 'Sentry org slug' },
        project: { kind: 'string', describe: 'Sentry project slug' },
      },
      required: ['organization', 'project'],
    },
    outputSchema: {
      kind: 'object',
      describe: 'Sync result',
      properties: {
        upserted: { kind: 'integer', describe: 'Issues upserted' },
        cursor: { kind: 'string', describe: 'Next-page cursor', nullable: true },
      },
      required: ['upserted'],
    },
    requiredScopes: ['databases.write'],
    requiredOAuth: ['sentry'],
    rationale: 'Pulls open Sentry issues every 15 minutes and upserts into Notion.',
  },
  expectedSource: `/**
 * Sync Sentry issues every 15min.
 * Pattern: sync-source
 */
import { worker, j } from '@notion/workers-sdk';
import { Client as NotionClient } from '@notionhq/client';
import { createSentryClient } from '@forge/connectors/sentry';

const notion = new NotionClient({ auth: process.env['NOTION_API_KEY'] ?? '' });
const sentry = createSentryClient({ apiKey: process.env['SENTRY_API_TOKEN'] ?? '' });

worker.sync({
  name: 'sentry-issues-sync',
  description: 'Sync Sentry issues into Notion every 15 minutes',
  input: j.object({
    organization: j.string().describe('Sentry org slug'),
    project: j.string().describe('Sentry project slug'),
  }).required(['organization', 'project']).describe('Sentry sync input'),
  output: j.object({
    upserted: j.integer().describe('Issues upserted'),
    cursor: j.string().nullable().describe('Next-page cursor'),
  }).required(['upserted']).describe('Sync result'),
  async handler(input, ctx: { cursor: string | null }) {
    const dbId = process.env['NOTION_DATABASE_ID'] ?? '';
    if (dbId.length === 0) {
      return { ok: false as const, error: 'NOTION_DATABASE_ID missing', cursor: ctx.cursor };
    }
    try {
      const page = await sentry.listIssues({
        organization: input.organization,
        project: input.project,
        query: 'is:unresolved',
        cursor: ctx.cursor,
      });
      let upserted = 0;
      for (const issue of page.issues) {
        await notion.pages.create({
          parent: { database_id: dbId },
          properties: {
            Name: { title: [{ text: { content: issue.title } }] },
            Level: { select: { name: issue.level ?? 'error' } },
            Count: { number: issue.count ?? 0 },
          } as never,
        });
        upserted += 1;
      }
      return { ok: true as const, upserted, cursor: page.nextCursor ?? null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message, cursor: ctx.cursor };
    }
  },
});
`,
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. external-api-call — "Look up a GitHub repo's metadata"
// ─────────────────────────────────────────────────────────────────────────────

const FX_GITHUB_REPO_LOOKUP: FewShotExample = {
  description: 'Look up GitHub repo metadata and return stars/forks/issues',
  schema: {
    pattern: 'external-api-call',
    inputSchema: {
      kind: 'object',
      describe: 'GitHub repo identifier',
      properties: {
        owner: { kind: 'string', describe: 'Owner login' },
        repo: { kind: 'string', describe: 'Repo name' },
      },
      required: ['owner', 'repo'],
    },
    outputSchema: {
      kind: 'object',
      describe: 'Repo metadata',
      properties: {
        stars: { kind: 'integer', describe: 'Stargazer count' },
        forks: { kind: 'integer', describe: 'Forks count' },
        openIssues: { kind: 'integer', describe: 'Open issues count' },
        url: { kind: 'string', describe: 'Repo html_url' },
      },
      required: ['stars', 'forks', 'openIssues', 'url'],
    },
    requiredScopes: [],
    requiredOAuth: ['github'],
    rationale: 'Calls GitHub repos.get and returns the key stats.',
  },
  expectedSource: `/**
 * Look up GitHub repo metadata and return stars/forks/issues.
 * Pattern: external-api-call
 */
import { worker, j } from '@notion/workers-sdk';
import { createGithubClient } from '@forge/connectors/github';

const github = createGithubClient({ apiKey: process.env['GITHUB_TOKEN'] ?? '' });

worker.tool({
  name: 'github-repo-metadata',
  description: 'Return stars/forks/issues for a public GitHub repo',
  input: j.object({
    owner: j.string().describe('Owner login'),
    repo: j.string().describe('Repo name'),
  }).required(['owner', 'repo']).describe('GitHub repo identifier'),
  output: j.object({
    stars: j.integer().describe('Stargazer count'),
    forks: j.integer().describe('Forks count'),
    openIssues: j.integer().describe('Open issues count'),
    url: j.string().describe('Repo html_url'),
  }).required(['stars', 'forks', 'openIssues', 'url']).describe('Repo metadata'),
  async handler(input) {
    try {
      const repo = await github.getRepo({ owner: input.owner, repo: input.repo });
      return {
        ok: true as const,
        result: {
          stars: repo.stargazers_count ?? 0,
          forks: repo.forks_count ?? 0,
          openIssues: repo.open_issues_count ?? 0,
          url: repo.html_url,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  },
});
`,
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. multi-step — "Read Notion task → GitHub issues → Slack message"
// ─────────────────────────────────────────────────────────────────────────────

const FX_MULTISTEP_TRIAGE: FewShotExample = {
  description:
    "Read a Notion task, look up assignee's open GitHub issues, summarize, post Slack message",
  schema: {
    pattern: 'multi-step',
    inputSchema: {
      kind: 'object',
      describe: 'Triage input',
      properties: {
        pageId: { kind: 'string', describe: 'Notion task page id' },
        slackChannel: { kind: 'string', describe: 'Slack channel id to post into' },
      },
      required: ['pageId', 'slackChannel'],
    },
    outputSchema: {
      kind: 'object',
      describe: 'Triage outcome',
      properties: {
        steps: {
          kind: 'array',
          describe: 'Per-step trace',
          items: {
            kind: 'object',
            describe: 'Step trace',
            properties: {
              name: { kind: 'string', describe: 'Step name' },
              ok: { kind: 'boolean', describe: 'Whether the step succeeded' },
            },
            required: ['name', 'ok'],
          },
        },
        slackTs: { kind: 'string', describe: 'Slack message ts', nullable: true },
      },
      required: ['steps'],
    },
    requiredScopes: ['pages.read'],
    requiredOAuth: ['github', 'slack'],
    rationale:
      'Reads the Notion task page, fetches the assignee’s open GitHub issues, summarizes them and posts to Slack.',
  },
  expectedSource: `/**
 * Read a Notion task, look up assignee's open GitHub issues, summarize, post Slack message.
 * Pattern: multi-step
 */
import { worker, j } from '@notion/workers-sdk';
import { Client as NotionClient } from '@notionhq/client';
import { createGithubClient } from '@forge/connectors/github';
import { createSlackClient } from '@forge/connectors/slack';

const notion = new NotionClient({ auth: process.env['NOTION_API_KEY'] ?? '' });
const github = createGithubClient({ apiKey: process.env['GITHUB_TOKEN'] ?? '' });
const slack = createSlackClient({ apiKey: process.env['SLACK_BOT_TOKEN'] ?? '' });

void (() => [github, slack])();

worker.tool({
  name: 'triage-task',
  description: 'Triage a Notion task by pulling GitHub issues and notifying Slack',
  input: j.object({
    pageId: j.string().describe('Notion task page id'),
    slackChannel: j.string().describe('Slack channel id'),
  }).required(['pageId', 'slackChannel']).describe('Triage input'),
  output: j.object({
    steps: j.array(
      j.object({
        name: j.string().describe('Step name'),
        ok: j.boolean().describe('Whether the step succeeded'),
      }).required(['name', 'ok']).describe('Step trace'),
    ).describe('Per-step trace'),
    slackTs: j.string().nullable().describe('Slack message ts'),
  }).required(['steps']).describe('Triage outcome'),
  async handler(input) {
    const steps: Array<{ name: string; ok: boolean }> = [];
    try {
      const page = await notion.pages.retrieve({ page_id: input.pageId });
      steps.push({ name: 'read-notion', ok: true });

      const assignee = extractAssignee(page);
      if (!assignee) {
        steps.push({ name: 'extract-assignee', ok: false });
        return { ok: false as const, steps, error: 'No assignee on task' };
      }
      steps.push({ name: 'extract-assignee', ok: true });

      const issues = await github.listIssues({ assignee, state: 'open' });
      steps.push({ name: 'github-list', ok: true });

      const summary = issues
        .slice(0, 5)
        .map((i) => '- ' + i.title + ' (#' + String(i.number) + ')')
        .join('\\n');
      const post = await slack.postMessage({
        channel: input.slackChannel,
        text: 'Open issues for ' + assignee + ':\\n' + summary,
      });
      steps.push({ name: 'slack-post', ok: true });

      return { ok: true as const, steps, slackTs: post.ts ?? null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, steps, error: message };
    }
  },
});

function extractAssignee(page: unknown): string | null {
  const props = (page as { properties?: Record<string, unknown> }).properties ?? {};
  const assignee = props['Assignee'] as { people?: Array<{ name?: string }> } | undefined;
  const name = assignee?.people?.[0]?.name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}
`,
};

// ─────────────────────────────────────────────────────────────────────────────
// Exported array (ordering = curriculum order for the model)
// ─────────────────────────────────────────────────────────────────────────────

export const FEW_SHOT_EXAMPLES: readonly FewShotExample[] = Object.freeze([
  FX_LINEAR_BUGS,
  FX_RECENT_NOTION_PAGES,
  FX_GITHUB_PR_RELEASE_NOTE,
  FX_STRIPE_CHARGE,
  FX_VERCEL_DEPLOYMENTS,
  FX_SENTRY_ISSUES,
  FX_GITHUB_REPO_LOOKUP,
  FX_MULTISTEP_TRIAGE,
]);
