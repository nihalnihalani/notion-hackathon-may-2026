# @forge/connectors

First-party connector SDKs that Forge-generated agents import for outbound calls to third-party services. Each connector is a thin, typed, OAuth-scope-minimised wrapper with consistent retry, rate-limit, and timeout semantics so generated TypeScript stays small and predictable.

## Design rules

- **Production only** — no demo paths, mock fetch, or test branches in `src/`.
- **TypeScript strict**, ESM, native `fetch` (Edge-compatible).
- **Factory pattern**: `createXClient(config)` → typed methods. No classes, no module state, nothing read from `process.env`.
- **Typed responses** inferred from zod schemas (`z.infer<typeof X>`).
- **Validation is opt-in** per call: `{ validate: true }` runs the zod parser; default off. The LLM is the primary caller — we trust the API more than we trust the LLM, but you can flip it on for high-stakes paths.
- **Errors throw** as `ConnectorError` subclasses (`AuthError`, `NotFoundError`, `ValidationError`, `RateLimitError`).
- **Retries**: shared HTTP helper retries 429 + 5xx with exponential backoff + jitter (3 retries, 250ms → 8s cap). 401/403/404/422 throw immediately.

## Connector inventory

| Provider | Module | Factory |
|---|---|---|
| GitHub | `@forge/connectors/github` | `createGithubClient` |
| Linear | `@forge/connectors/linear` | `createLinearClient` |
| Stripe | `@forge/connectors/stripe` | `createStripeClient` |
| Slack | `@forge/connectors/slack` | `createSlackClient` |
| Gmail | `@forge/connectors/google` | `createGmailClient` |
| Google Calendar | `@forge/connectors/google` | `createCalendarClient` |
| Sentry | `@forge/connectors/sentry` | `createSentryClient` |
| Vercel | `@forge/connectors/vercel` | `createVercelClient` |
| Anthropic | `@forge/connectors/anthropic` | `createAnthropicClient` |
| OpenAI | `@forge/connectors/openai` | `createOpenaiClient` |
| MiniMax | `@forge/connectors/minimax` | `createMinimaxClient` |

## Usage (the shape Tool Coder generates)

```ts
import { createGithubClient } from '@forge/connectors/github';

const gh = createGithubClient({ apiKey: env.GITHUB_TOKEN });
const prs = await gh.listOpenPRs('vercel/next.js');
```

```ts
import { createAnthropicClient } from '@forge/connectors/anthropic';

const claude = createAnthropicClient({
  apiKey: env.ANTHROPIC_API_KEY,
  gatewayUrl: env.AI_GATEWAY_URL, // optional — Vercel AI Gateway
});
const res = await claude.complete({
  model: 'claude-opus-4-7',
  maxTokens: 1024,
  system: 'You are a triage agent.',
  cacheControl: true, // wraps system in ephemeral cache_control
  messages: [{ role: 'user', content: 'Hi' }],
});
console.log(res.usage.cache_read_input_tokens);
```
