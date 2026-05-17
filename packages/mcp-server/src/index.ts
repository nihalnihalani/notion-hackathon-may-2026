/**
 * `@forge/mcp-server` — public API surface.
 *
 * Named exports only. Anything added here should also appear in a test
 * exercise so the surface stays intentional and reviewable.
 *
 * Consumers:
 *   - `apps/web/app/api/mcp/route.ts` — imports `createForgeMcpServer` +
 *     `handleMcpHttpRequest`.
 *   - Future stdio entry — would use `createForgeMcpServer` + the SDK's
 *     `StdioServerTransport`. Not built yet.
 */

// ─── Factory + server constants ────────────────────────────────────────────
export {
  createForgeMcpServer,
  FORGE_MCP_SERVER_NAME,
  FORGE_MCP_SERVER_VERSION,
} from './server.js';

// ─── Transport adapter ─────────────────────────────────────────────────────
export { handleMcpHttpRequest } from './transport.js';

// ─── Pure tool handlers (exported for fine-grained testing + reuse) ────────
export {
  forgeAgent,
  getGenerationStatus,
  listMyAgents,
} from './tools.js';

// ─── Prompts ───────────────────────────────────────────────────────────────
export {
  forgeDescribeAgentArgsSchema,
  forgeDescribeAgentArgsShape,
  forgeDiagnoseFailureArgsSchema,
  forgeDiagnoseFailureArgsShape,
  PROMPT_CATALOG,
  renderDescribeAgentPrompt,
  renderDiagnoseFailurePrompt,
} from './prompts.js';
export type { ForgeDescribeAgentArgs, ForgeDiagnoseFailureArgs, PromptName } from './prompts.js';

// ─── Resource ──────────────────────────────────────────────────────────────
export {
  FORGE_AGENTS_RESOURCE_METADATA,
  FORGE_AGENTS_URI,
  readForgeAgentsResource,
} from './resources.js';

// ─── Error hierarchy ───────────────────────────────────────────────────────
export {
  AgentListError,
  ForgeMcpError,
  GenerationNotFoundError,
  InvalidInputError,
  toMcpErrorContent,
  WorkflowTriggerError,
} from './errors.js';
export type { ForgeMcpErrorCode } from './errors.js';

// ─── Types + zod input shapes ──────────────────────────────────────────────
export {
  forgeAgentInputSchema,
  forgeAgentInputShape,
  getGenerationStatusInputSchema,
  getGenerationStatusInputShape,
  listMyAgentsInputSchema,
  listMyAgentsInputShape,
  noopLogger,
} from './types.js';
export type {
  ForgeAgentInput,
  ForgeMcpConfig,
  ForgeMcpContext,
  GeneratedAgentView,
  GenerationStatusView,
  GenerationStepView,
  GetGenerationStatusInput,
  ListMyAgentsInput,
  Logger,
  WorkflowTriggerInput,
  WorkflowTriggerResult,
} from './types.js';
