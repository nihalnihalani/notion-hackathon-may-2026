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

// ─── Sub-agent entry points (Schema Smith only at this revision) ────────────
export { schemaSmith, type SchemaSmithInput } from './schema-smith.js';

// Siblings will land alongside:
// export { toolCoder, type ToolCoderInput } from './tool-coder.js';
// export { inspector, type InspectorInput } from './inspector.js';
// export { shipper, type ShipperInput } from './shipper.js';

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
