/**
 * @forge/agents — public surface.
 *
 * Named exports only. The four sub-agents each ship from their own module
 * (`./schema-smith`, `./tool-coder`, `./inspector`, `./shipper`) and the
 * package.json `exports` map mirrors that layout so callers can import a
 * single sub-agent without pulling the whole bundle.
 *
 * Shared types, errors, and cost helpers live here at the root.
 */

// ─── Sub-agent entry points ─────────────────────────────────────────────────
export { schemaSmith, type SchemaSmithInput } from './schema-smith.js';
export { toolCoder, type ToolCoderInput } from './tool-coder.js';
export { inspector, type InspectorInput } from './inspector.js';
export {
  shipper,
  type ShipperInput,
  type ShipperSubAgentConfig,
  type ShipperResendClient,
  type ShipperPrismaClient,
  type GeneratedAgentRow,
  type PrismaAgentPattern,
  type VercelBlobPutFn,
  type MinimaxConfig,
} from './shipper.js';

// ─── Shipper helpers (also usable standalone) ──────────────────────────────
export { wireCustomAgent } from './custom-agent-wiring.js';
export type {
  WireCustomAgentArgs,
  WireCustomAgentResult,
} from './custom-agent-wiring.js';
export { deriveAvatarPrompt } from './avatar-prompt.js';
export { formatReleaseNotes } from './release-notes.js';
export type { FormatReleaseNotesArgs } from './release-notes.js';

// ─── Tool Coder Worker code templates ──────────────────────────────────────
export {
  databaseQueryTemplate,
  type DatabaseQueryTemplateArgs,
} from './templates/database-query.js';
export {
  webhookTriggerTemplate,
  type WebhookTriggerTemplateArgs,
} from './templates/webhook-trigger.js';
export {
  syncSourceTemplate,
  type SyncSourceTemplateArgs,
} from './templates/sync-source.js';
export {
  externalApiCallTemplate,
  type ExternalApiCallTemplateArgs,
} from './templates/external-api-call.js';
export {
  multiStepTemplate,
  type MultiStepTemplateArgs,
} from './templates/multi-step.js';

// ─── Few-shot catalog (system-prompt content + evaluation fixtures) ─────────
export { FEW_SHOT_EXAMPLES, type FewShotExample } from './few-shot/index.js';

// ─── Tool Coder pure helpers ────────────────────────────────────────────────
export {
  parseGeneratedTs,
  extractTsCodeFromResponse,
  type ParseGeneratedTsResult,
} from './ts-validation.js';
export { deriveWorkerName, validateWorkerName } from './worker-name.js';

// ─── Inspector sandbox runners ──────────────────────────────────────────────
export { createVercelSandbox, createInProcessSandbox } from './sandbox.js';
export type {
  SandboxRunner,
  SandboxRunOptions,
  SandboxRunResult,
  SandboxFile,
  VercelSandboxConfig,
  InProcessSandboxConfig,
} from './sandbox.js';

// ─── Inspector pure helpers ─────────────────────────────────────────────────
export {
  generateSynthetic,
  validateAgainstOutputSchema,
  type ValidateOutputResult,
} from './synthetic.js';
export { parseTscErrors, type TscError } from './tsc-error-parser.js';

// ─── Shared types ───────────────────────────────────────────────────────────
export {
  ALL_AGENT_PATTERNS,
  agentPatternSchema,
  inspectionResultSchema,
  jSchemaSpecSchema,
  noopLogger,
  notionScopeSchema,
  providerNameSchema,
  schemaSmithOutputSchema,
  shipperResultSchema,
  toolCoderOutputSchema,
  workspaceContextSchema,
} from './types.js';
export type {
  AgentPattern,
  AnthropicClientLike,
  InspectionResult,
  JSchemaSpec,
  NotionScope,
  OpenaiClientLike,
  ProviderName,
  SchemaSmithOutput,
  ShipperResult,
  SubAgentCompleteEvent,
  SubAgentConfig,
  SubAgentLogger,
  ToolCoderOutput,
  WorkspaceContext,
} from './types.js';

// ─── J-schema helpers (Tool Coder will consume `renderJSchemaAsTS`) ─────────
export { renderJSchemaAsTS, validateJSchema, type ValidateJSchemaResult } from './schema/j-spec.js';

// ─── Cost helpers ───────────────────────────────────────────────────────────
export {
  ANTHROPIC_PRICES_USD_PER_MTOK,
  anthropicCostUsd,
  OPENAI_PRICES_USD_PER_MTOK,
  openaiCostUsd,
  type AnthropicUsage,
  type OpenaiUsage,
} from './cost.js';

// ─── Error hierarchy ────────────────────────────────────────────────────────
export {
  InspectorError,
  ProviderFallbackError,
  SchemaSmithError,
  ShipperError,
  SubAgentError,
  ToolCoderError,
  type SubAgentErrorInit,
} from './errors.js';
