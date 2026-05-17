#!/usr/bin/env tsx
/**
 * verify-env.ts — runtime validation of every environment variable Forge needs.
 *
 * Run: `pnpm verify:env` (or `tsx scripts/verify-env.ts`)
 *
 * Exits 0 if every required variable is set and shape-correct.
 * Exits 1 with a grouped, human-readable list of failures otherwise.
 *
 * The schema below MUST stay in sync with .env.example. If you add a new env
 * var to .env.example, add it here too — and prefer a structural refinement
 * (regex, URL, prefix) over a bare `min(1)` so we catch swapped or
 * placeholder values during local setup *before* they hit production.
 *
 * Loads .env from the repo root via `dotenv/config` so this script works for
 * both CI (which sets process.env directly) and local devs (who use .env).
 */
import 'dotenv/config';
import { z } from 'zod';

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

// When FORGE_PRIMARY_PROVIDER=openai the Anthropic path is never reached, so
// ANTHROPIC_API_KEY becomes optional. In every other case (default = anthropic
// primary) we keep the strict regex so misconfig is loud.
const PROVIDER = process.env['FORGE_PRIMARY_PROVIDER'] === 'openai' ? 'openai' : 'anthropic';

const anthropicKeySchema =
  PROVIDER === 'openai'
    ? optionalNonEmptyString.refine(
        (s) => s === undefined || /^sk-ant-/.test(s),
        'when set, must start with "sk-ant-" (Anthropic API key format)',
      )
    : z.string().regex(/^sk-ant-/, 'must start with "sk-ant-" (Anthropic API key format)');

const envSchema = z.object({
  // App
  NEXT_PUBLIC_APP_URL: z.string().url('must be a valid URL'),

  // Anthropic — required by default; optional when FORGE_PRIMARY_PROVIDER=openai.
  ANTHROPIC_API_KEY: anthropicKeySchema,

  // OpenAI
  // Real OpenAI keys are `sk-` followed by an optional class prefix
  // (`proj-`, `svcacct-`, `admin-`, or `None-` for legacy/personal) and at
  // least 20 chars of `[A-Za-z0-9_-]`. The previous regex (`/^sk-(proj-)?/`)
  // accepted literally `sk-` which is useless as a guard.
  //
  // We additionally refuse a `fake-ci-stub` placeholder when CI=false so a
  // contributor who copy-pasted the CI stub into their local .env hears
  // about it before shipping a request with no real key.
  OPENAI_API_KEY: z
    .string()
    .regex(/^sk-(proj-|svcacct-|admin-|None-)?[A-Za-z0-9_-]{20,}$/, 'invalid OpenAI key format')
    .refine(
      (s) => !s.includes('fake-ci-stub') || process.env['CI'] === 'true',
      'placeholder key in non-CI env',
    ),
  OPENAI_ORG_ID: optionalNonEmptyString,

  // Notion Developer Platform
  NOTION_OAUTH_CLIENT_ID: z.string().trim().min(1, 'must be non-empty'),
  NOTION_OAUTH_CLIENT_SECRET: z.string().trim().min(1, 'must be non-empty'),
  NOTION_OAUTH_REDIRECT_URI: z.string().url('must be a valid URL'),
  NOTION_WEBHOOK_SECRET: z.string().trim().min(1, 'must be non-empty'),
  NTN_VERSION: z.string().trim().min(1, 'must be non-empty'),

  // Clerk
  CLERK_SECRET_KEY: z
    .string()
    .regex(/^sk_(test|live)_/, 'must start with "sk_test_" or "sk_live_"'),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z
    .string()
    .regex(/^pk_(test|live)_/, 'must start with "pk_test_" or "pk_live_"'),
  CLERK_WEBHOOK_SECRET: z.string().trim().min(1, 'must be non-empty'),
  CLERK_JWT_KEY: z.string().trim().min(1, 'must be non-empty'),

  // PlanetScale (Postgres)
  DATABASE_URL: z
    .string()
    .url('must be a valid URL')
    .refine(
      (s) => s.startsWith('postgres://') || s.startsWith('postgresql://'),
      'must start with postgres:// or postgresql://',
    ),

  // Vercel
  VERCEL_AI_GATEWAY_API_KEY: z.string().trim().min(1, 'must be non-empty'),
  VERCEL_BLOB_READ_WRITE_TOKEN: z
    .string()
    .startsWith('vercel_blob_rw_', 'must start with "vercel_blob_rw_" (Vercel Blob R/W token)'),
  VERCEL_EDGE_CONFIG: z.string().trim().min(1, 'must be non-empty'),

  // Observability — Sentry DSNs are just URLs so self-hosted Sentry works too.
  SENTRY_DSN: z.string().url('must be a valid URL'),
  NEXT_PUBLIC_SENTRY_DSN: z.string().url('must be a valid URL'),
  SENTRY_AUTH_TOKEN: z.string().trim().min(1, 'must be non-empty'),
  SENTRY_ORG: z.string().trim().min(1, 'must be non-empty'),
  SENTRY_PROJECT: z.string().trim().min(1, 'must be non-empty'),
  POSTHOG_KEY: z.string().trim().min(1, 'must be non-empty'),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().trim().min(1, 'must be non-empty'),

  // Email
  RESEND_API_KEY: z.string().regex(/^re_/, 'must start with "re_" (Resend API key format)'),
  RESEND_FROM_EMAIL: z.string().email('must be a valid email address'),

  // Upstash Redis — don't pin .upstash.io because Upstash supports custom domains.
  UPSTASH_REDIS_REST_URL: z.string().url('must be a valid URL'),
  UPSTASH_REDIS_REST_TOKEN: z.string().trim().min(1, 'must be non-empty'),

  // MiniMax
  MINIMAX_API_KEY: z.string().trim().min(1, 'must be non-empty'),
  MINIMAX_GROUP_ID: z.string().trim().min(1, 'must be non-empty'),

  // Stripe
  STRIPE_SECRET_KEY: z
    .string()
    .regex(/^sk_(test|live)_/, 'must start with "sk_test_" or "sk_live_"'),
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .regex(/^whsec_/, 'must start with "whsec_" (Stripe webhook secret format)'),

  // Inngest — optional backup pipeline.
  INNGEST_EVENT_KEY: optionalNonEmptyString,
  INNGEST_SIGNING_KEY: optionalNonEmptyString,

  // Internal
  FORGE_INTERNAL_TOKEN: z
    .string()
    .min(32, 'must be at least 32 characters (use `openssl rand -hex 32`)')
    .refine(
      (s) => s !== 'REPLACE_ME',
      'placeholder value detected — rotate FORGE_INTERNAL_TOKEN before use',
    ),
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
