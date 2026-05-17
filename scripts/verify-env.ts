#!/usr/bin/env tsx
/**
 * verify-env.ts — runtime validation of every environment variable Forge needs.
 *
 * Run: `pnpm verify:env` (or `tsx scripts/verify-env.ts`)
 *
 * Exits 0 if every required variable is set and well-formed.
 * Exits 1 with a grouped, human-readable list of failures otherwise.
 *
 * The schema below MUST stay in sync with .env.example. If you add a new env
 * var to .env.example, add it here too.
 */
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1, 'must be non-empty');
const url = z.string().url('must be a valid URL');

const envSchema = z.object({
  // Anthropic
  ANTHROPIC_API_KEY: nonEmpty,

  // OpenAI
  OPENAI_API_KEY: nonEmpty,

  // Notion Developer Platform
  NOTION_OAUTH_CLIENT_ID: nonEmpty,
  NOTION_OAUTH_CLIENT_SECRET: nonEmpty,
  NOTION_WEBHOOK_SECRET: nonEmpty,
  NTN_VERSION: nonEmpty,

  // Clerk
  CLERK_SECRET_KEY: nonEmpty,
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: nonEmpty,

  // PlanetScale
  DATABASE_URL: nonEmpty,

  // Vercel
  VERCEL_AI_GATEWAY_API_KEY: nonEmpty,
  VERCEL_BLOB_READ_WRITE_TOKEN: nonEmpty,
  VERCEL_EDGE_CONFIG: nonEmpty,

  // Observability
  SENTRY_DSN: url,
  NEXT_PUBLIC_SENTRY_DSN: url,
  POSTHOG_KEY: nonEmpty,
  NEXT_PUBLIC_POSTHOG_KEY: nonEmpty,

  // Email
  RESEND_API_KEY: nonEmpty,

  // Upstash Redis
  UPSTASH_REDIS_REST_URL: url,
  UPSTASH_REDIS_REST_TOKEN: nonEmpty,

  // MiniMax
  MINIMAX_API_KEY: nonEmpty,

  // Internal
  FORGE_INTERNAL_TOKEN: nonEmpty,
});

const RED = '[31m';
const GREEN = '[32m';
const BOLD = '[1m';
const RESET = '[0m';

const result = envSchema.safeParse(process.env);

if (result.success) {
  process.stdout.write(
    `${GREEN}${BOLD}OK${RESET} All ${String(Object.keys(envSchema.shape).length)} required environment variables are present and well-formed.\n`,
  );
  process.exit(0);
}

process.stderr.write(
  `${RED}${BOLD}FAIL${RESET} ${String(result.error.issues.length)} environment variable problem(s) detected:\n\n`,
);
for (const issue of result.error.issues) {
  const name = issue.path.join('.');
  process.stderr.write(`  - ${BOLD}${name}${RESET}: ${issue.message}\n`);
}
process.stderr.write(
  `\nFix by editing your ${BOLD}.env${RESET} (or .env.local for apps/web). See ${BOLD}.env.example${RESET} for the full list with descriptions.\n`,
);
process.exit(1);
