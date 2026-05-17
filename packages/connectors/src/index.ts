/**
 * @forge/connectors — first-party typed connector SDKs.
 *
 * These are the modules imported by Forge-GENERATED Worker code. The API
 * surface is intentionally tiny: one factory per provider, methods that
 * return parsed JSON, and a single error hierarchy across all of them.
 *
 * Generated agent code looks like:
 *
 *   import { createGithubClient } from '@forge/connectors/github';
 *   const gh = createGithubClient({ apiKey: env.GITHUB_TOKEN });
 *   const prs = await gh.listOpenPRs('vercel/next.js');
 */

// ── Shared types + errors ────────────────────────────────────────────────────
export type {
  ConnectorConfig,
  FetchLike,
  RetryOptions,
  RateLimitInfo,
  RequestOptions,
} from './types.js';
export { DEFAULT_RETRY } from './types.js';

export {
  ConnectorError,
  RateLimitError,
  AuthError,
  NotFoundError,
  ValidationError,
} from './errors.js';

// ── HTTP helper (exposed for connector authors + advanced agent code) ───────
export { makeRequest, buildContext } from './http.js';
export type { MakeRequestOptions, HttpClientContext } from './http.js';

// ── Connector factories ─────────────────────────────────────────────────────
export { createGithubClient } from './github/index.js';
export type {
  GithubClient,
  CreateIssueParams,
  GithubPR,
  GithubIssue,
  GithubRepo,
  GithubUser,
  GithubLabel,
  GithubComment,
  GithubMergeResult,
} from './github/index.js';

export { createLinearClient } from './linear/index.js';
export type {
  LinearClient,
  CreateLinearIssueParams,
  LinearIssue,
  LinearProject,
  LinearTeam,
  LinearUser,
  LinearComment,
  LinearWorkflowState,
} from './linear/index.js';

export { createStripeClient } from './stripe/index.js';
export type {
  StripeClient,
  StripeCharge,
  StripeRefund,
  StripeCustomer,
  StripeSubscription,
} from './stripe/index.js';

export { createSlackClient } from './slack/index.js';
export type {
  SlackClient,
  PostMessageOptions,
  ListChannelsOptions,
  SlackChannel,
  SlackUser,
  SlackMessage,
  SlackBlock,
} from './slack/index.js';

export { createGmailClient, createCalendarClient } from './google/index.js';
export type {
  GmailClient,
  CalendarClient,
  CreateCalendarEventParams,
  GmailMessage,
  GmailMessageStub,
  GmailSendResponse,
  CalendarEvent,
  CalendarTime,
  CalendarAttendee,
} from './google/index.js';

export { createSentryClient } from './sentry/index.js';
export type { SentryClient, SentryIssue, SentryEvent } from './sentry/index.js';

export { createVercelClient } from './vercel/index.js';
export type {
  VercelClient,
  VercelDeployment,
  VercelProject,
} from './vercel/index.js';

export { createAnthropicClient } from './anthropic/index.js';
export type {
  AnthropicClient,
  AnthropicConfig,
  CompleteParams as AnthropicCompleteParams,
  AnthropicMessage,
  AnthropicResponse,
  AnthropicUsage,
  AnthropicSystem,
  AnthropicContentBlockInput,
  AnthropicCacheControl,
} from './anthropic/index.js';

export { createOpenaiClient } from './openai/index.js';
export type {
  OpenaiClient,
  OpenaiConfig,
  OpenaiCompleteParams,
  OpenaiEmbedParams,
  OpenaiChatMessage,
  OpenaiChatResponse,
  OpenaiEmbeddingResponse,
  OpenaiUsage,
} from './openai/index.js';

export { createMinimaxClient } from './minimax/index.js';
export type {
  MinimaxClient,
  TranscribeParams,
  SpeakParams,
  GenerateImageParams,
  MinimaxT2AResponse,
  MinimaxTranscribeResponse,
  MinimaxImageResponse,
} from './minimax/index.js';
