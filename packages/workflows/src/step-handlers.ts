/**
 * Step handlers — thin wrappers around each sub-agent that own the boilerplate
 * for: Notion log → DB step start → sub-agent call → DB step finish → Notion
 * log. Keeping this here means `forge.ts` and `inngest/forge.ts` are both
 * readable as a list of `await runX(...)` calls — and ensures the Vercel
 * Workflow DevKit path and the Inngest path produce identical DB rows + log
 * entries.
 *
 * Each handler returns a `WorkflowStepResult` discriminant so the orchestrator
 * can pass the output downstream without losing type narrowing.
 *
 * Handlers DO NOT catch sub-agent errors — they let them propagate so the
 * outer workflow framework can apply its retry policy. The only exception is
 * the Inspector, which returns `{ pass: false }` for *validation* failures
 * (those are normal outcomes, not exceptions) and only throws on infra
 * failures.
 */

import {
  defaultPrimaryModelForProvider,
  inspector,
  resolvePrimaryProvider,
  schemaSmith,
  shipper,
  toolCoder,
  type InspectionResult,
  type SchemaSmithInput,
  type SchemaSmithOutput,
  type ShipperInput,
  type ShipperResult,
  type SubAgentCompleteEvent,
  type SubAgentConfig,
  type ToolCoderInput,
  type ToolCoderOutput,
  type WorkspaceContext,
} from '@forge/agents';
import type { InspectorInput } from '@forge/agents';

import type { DiscoveredContext, WorkflowConfig, WorkflowStepResult } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Schema Smith
// ─────────────────────────────────────────────────────────────────────────────

export interface RunSchemaSmithArgs {
  generationId: string;
  description: string;
  workspaceContext: WorkspaceContext;
  buildLogBlockId: string;
  /** 1-indexed attempt number. The orchestrator increments on retries. */
  attempt: number;
  config: WorkflowConfig;
}

/**
 * Run Schema Smith. Persists a `running` GenerationStep, calls the sub-agent,
 * then persists the terminal `succeeded` / `failed` row.
 *
 * Throws if Schema Smith itself throws (propagated for retry by the outer
 * framework). Does NOT throw on `pattern: null` — the caller inspects
 * `result.output.pattern` and decides whether to halt.
 */
export async function runSchemaSmith(
  args: RunSchemaSmithArgs,
): Promise<Extract<WorkflowStepResult, { kind: 'schema-smith' }>> {
  const { generationId, description, workspaceContext, attempt, config } = args;

  await safeLog(config, args.buildLogBlockId, {
    step: 'Schema Smith',
    status: 'running',
    message: 'planning agent shape…',
  });

  const startedAt = performance.now();
  const stepRow = await config.db.recordStep({
    kind: 'start',
    generationId,
    agent: 'schema_smith',
    attempt,
    modelUsed: resolveModelUsed(config),
    inputJson: {
      description,
      databaseCount: workspaceContext.databases.length,
      existingAgentCount: workspaceContext.existingAgents.length,
    },
  });

  const trace = createSubAgentTrace(config, 'schema_smith');
  const subInput: SchemaSmithInput = {
    description,
    workspaceContext,
    config: trace.subAgentConfig,
  };

  try {
    const output: SchemaSmithOutput = await schemaSmith(subInput);
    const latencyMs = Math.round(performance.now() - startedAt);
    const usage = trace.complete();
    await config.db.recordStep({
      kind: 'finish',
      id: stepRow.id,
      status: 'succeeded',
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      cacheReadTokens: usage?.cacheReadTokens ?? null,
      cacheWriteTokens: usage?.cacheWriteTokens ?? null,
      costUsd: usage?.costUsd ?? null,
      outputJson: output,
      latencyMs,
      completedAt: new Date(),
    });
    await safeLog(config, args.buildLogBlockId, {
      step: 'Schema Smith',
      status: output.pattern === null ? 'info' : 'succeeded',
      message:
        output.pattern === null
          ? `needs clarification: ${truncate(output.rationale, 200)}`
          : `pattern=${output.pattern}, scopes=${output.requiredScopes.length}, oauth=${output.requiredOAuth.join(',') || 'none'}`,
    });
    return {
      kind: 'schema-smith',
      output,
      attempt,
      latencyMs,
      costUsd: usage?.costUsd ?? 0,
      stepRowId: stepRow.id,
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    await config.db.recordStep({
      kind: 'finish',
      id: stepRow.id,
      status: 'failed',
      errorJson: errorToJson(error),
      latencyMs,
      completedAt: new Date(),
    });
    await safeLog(config, args.buildLogBlockId, {
      step: 'Schema Smith',
      status: 'failed',
      message: `error: ${truncate(errMessage(error), 200)}`,
    });
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Coder
// ─────────────────────────────────────────────────────────────────────────────

export interface RunToolCoderArgs {
  generationId: string;
  description: string;
  schema: SchemaSmithOutput;
  prevErrors: readonly string[] | undefined;
  buildLogBlockId: string;
  attempt: number;
  config: WorkflowConfig;
}

/**
 * Run Tool Coder. When `prevErrors` is non-empty this is a feedback-loop
 * retry from a failed Inspector run — the sub-agent sees the errors in its
 * user prompt.
 */
export async function runToolCoder(
  args: RunToolCoderArgs,
): Promise<Extract<WorkflowStepResult, { kind: 'tool-coder' }>> {
  const { generationId, description, schema, prevErrors, attempt, config } = args;

  await safeLog(config, args.buildLogBlockId, {
    step: 'Tool Coder',
    status: 'running',
    message:
      prevErrors && prevErrors.length > 0
        ? `regenerating with ${prevErrors.length} prior error(s)…`
        : 'writing Worker source…',
  });

  const startedAt = performance.now();
  const stepRow = await config.db.recordStep({
    kind: 'start',
    generationId,
    agent: 'tool_coder',
    attempt,
    modelUsed: resolveModelUsed(config),
    inputJson: {
      description,
      schemaPattern: schema.pattern,
      prevErrorCount: prevErrors?.length ?? 0,
    },
  });

  const trace = createSubAgentTrace(config, 'tool_coder');
  const subInput: ToolCoderInput = {
    description,
    schema,
    config: trace.subAgentConfig,
    ...(prevErrors !== undefined && { prevErrors }),
  };

  try {
    const output: ToolCoderOutput = await toolCoder(subInput);
    const latencyMs = Math.round(performance.now() - startedAt);
    const usage = trace.complete();
    await config.db.recordStep({
      kind: 'finish',
      id: stepRow.id,
      status: 'succeeded',
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      cacheReadTokens: usage?.cacheReadTokens ?? null,
      cacheWriteTokens: usage?.cacheWriteTokens ?? null,
      costUsd: usage?.costUsd ?? null,
      outputJson: {
        sourceLines: output.sourceLines,
        workerName: output.workerName,
        depCount: Object.keys(output.packageJsonPatch.dependencies).length,
      },
      latencyMs,
      completedAt: new Date(),
    });
    await safeLog(config, args.buildLogBlockId, {
      step: 'Tool Coder',
      status: 'succeeded',
      message: `${output.sourceLines} lines, worker=${output.workerName}`,
    });
    return {
      kind: 'tool-coder',
      output,
      attempt,
      latencyMs,
      costUsd: usage?.costUsd ?? 0,
      stepRowId: stepRow.id,
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    await config.db.recordStep({
      kind: 'finish',
      id: stepRow.id,
      status: 'failed',
      errorJson: errorToJson(error),
      latencyMs,
      completedAt: new Date(),
    });
    await safeLog(config, args.buildLogBlockId, {
      step: 'Tool Coder',
      status: 'failed',
      message: `error: ${truncate(errMessage(error), 200)}`,
    });
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Inspector
// ─────────────────────────────────────────────────────────────────────────────

export interface RunInspectorArgs {
  generationId: string;
  code: ToolCoderOutput;
  schema: SchemaSmithOutput;
  buildLogBlockId: string;
  attempt: number;
  config: WorkflowConfig;
  /**
   * Sandbox runner — created once per generation by the orchestrator and
   * reused across Inspector retries (saves cold start). The orchestrator
   * `close()`'s it in its own `finally`.
   */
  sandbox: InspectorInput['config']['sandbox'];
}

/**
 * Run Inspector. Note: `pass: false` is a *normal* return value, not an
 * exception. Only sandbox/infra failures throw.
 */
export async function runInspector(
  args: RunInspectorArgs,
): Promise<Extract<WorkflowStepResult, { kind: 'inspector' }>> {
  const { generationId, code, schema, attempt, config, sandbox } = args;

  await safeLog(config, args.buildLogBlockId, {
    step: 'Inspector',
    status: 'running',
    message: 'safety scan → tsc → dry-run → exec…',
  });

  const startedAt = performance.now();
  const stepRow = await config.db.recordStep({
    kind: 'start',
    generationId,
    agent: 'inspector',
    attempt,
    modelUsed: null, // Inspector is no-LLM
    inputJson: {
      sourceLines: code.sourceLines,
      workerName: code.workerName,
      pattern: schema.pattern,
    },
  });

  const subInput: InspectorInput = {
    generationId,
    code,
    schema,
    config: { ...config.subAgent, sandbox },
  };

  try {
    const output: InspectionResult = await inspector(subInput);
    const latencyMs = Math.round(performance.now() - startedAt);
    await config.db.recordStep({
      kind: 'finish',
      id: stepRow.id,
      // Validation failure counts as a `succeeded` row at the step level —
      // we ran the inspection successfully and it produced a result. The
      // orchestrator decides whether to retry or fail the *generation*.
      status: 'succeeded',
      outputJson: {
        pass: output.pass,
        stage: output.stage,
        errorCount: output.errors.length,
        durationMs: output.durationMs,
      },
      latencyMs,
      completedAt: new Date(),
    });
    await safeLog(config, args.buildLogBlockId, {
      step: 'Inspector',
      status: output.pass ? 'succeeded' : 'info',
      message: output.pass
        ? `passed all stages (${output.durationMs}ms)`
        : `failed at ${output.stage}: ${truncate(output.errors[0] ?? 'unknown', 200)}`,
    });
    return {
      kind: 'inspector',
      output,
      attempt,
      latencyMs,
      costUsd: 0,
      stepRowId: stepRow.id,
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    await config.db.recordStep({
      kind: 'finish',
      id: stepRow.id,
      status: 'failed',
      errorJson: errorToJson(error),
      latencyMs,
      completedAt: new Date(),
    });
    await safeLog(config, args.buildLogBlockId, {
      step: 'Inspector',
      status: 'failed',
      message: `infrastructure error: ${truncate(errMessage(error), 200)}`,
    });
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shipper
// ─────────────────────────────────────────────────────────────────────────────

export interface RunShipperArgs {
  generationId: string;
  workspaceId: string;
  notionWorkspaceId: string;
  description: string;
  schema: SchemaSmithOutput;
  code: ToolCoderOutput;
  buildLogBlockId: string;
  attempt: number;
  config: WorkflowConfig;
  /**
   * Sandbox reused from the Inspector — the Shipper sub-agent requires it
   * for `ntn workers deploy`. The orchestrator owns the sandbox lifecycle.
   */
  sandbox: InspectorInput['config']['sandbox'];
}

/**
 * Run Shipper. Promotes the staging Worker → user workspace, wires the
 * Custom Agent, emits audit + usage events.
 */
export async function runShipper(
  args: RunShipperArgs,
): Promise<Extract<WorkflowStepResult, { kind: 'shipper' }>> {
  const {
    generationId,
    workspaceId,
    notionWorkspaceId,
    description,
    schema,
    code,
    attempt,
    config,
  } = args;

  await safeLog(config, args.buildLogBlockId, {
    step: 'Shipper',
    status: 'running',
    message: 'deploying to workspace…',
  });

  const startedAt = performance.now();
  const stepRow = await config.db.recordStep({
    kind: 'start',
    generationId,
    agent: 'shipper',
    attempt,
    modelUsed: null,
    inputJson: {
      workerName: code.workerName,
      pattern: schema.pattern,
      notionWorkspaceId,
    },
  });

  const subInput: ShipperInput = {
    generationId,
    workspaceId,
    notionWorkspaceId,
    description,
    schema,
    code,
    config: {
      ...config.subAgent,
      sandbox: args.sandbox,
      notionClient: config.shipper.notionClient,
      vercelBlob: {
        token: config.shipper.vercelBlob.token,
        ...(config.shipper.vercelBlob.put !== undefined && {
          put: config.shipper.vercelBlob.put,
        }),
      },
      dbClient: config.shipper.dbClient,
      ...(config.shipper.minimaxConfig !== undefined && {
        minimaxConfig: config.shipper.minimaxConfig,
      }),
      ...(config.shipper.resendClient !== undefined && {
        resendClient: config.shipper.resendClient,
      }),
      ...(config.shipper.emailTo !== undefined && {
        emailTo: config.shipper.emailTo,
      }),
      ...(config.shipper.emailFrom !== undefined && {
        emailFrom: config.shipper.emailFrom,
      }),
      ...(config.shipper.notionWorkspaceIdForLink !== undefined && {
        notionWorkspaceIdForLink: config.shipper.notionWorkspaceIdForLink,
      }),
    },
  };

  try {
    const output: ShipperResult = await shipper(subInput);
    const latencyMs = Math.round(performance.now() - startedAt);
    await config.db.recordStep({
      kind: 'finish',
      id: stepRow.id,
      status: 'succeeded',
      outputJson: {
        generatedAgentId: output.generatedAgentId,
        deployUrl: output.deployUrl,
        customAgentId: output.customAgentId,
        ntnWorkerName: output.ntnWorkerName,
        capabilitiesDiscovered: output.capabilitiesDiscovered,
      },
      latencyMs,
      completedAt: new Date(),
    });
    await safeLog(config, args.buildLogBlockId, {
      step: 'Shipper',
      status: 'succeeded',
      message: `deployed → ${output.deployUrl} (${output.capabilitiesDiscovered} capabilit${output.capabilitiesDiscovered === 1 ? 'y' : 'ies'})`,
    });
    return {
      kind: 'shipper',
      output,
      attempt,
      latencyMs,
      costUsd: 0,
      stepRowId: stepRow.id,
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    await config.db.recordStep({
      kind: 'finish',
      id: stepRow.id,
      status: 'failed',
      errorJson: errorToJson(error),
      latencyMs,
      completedAt: new Date(),
    });
    await safeLog(config, args.buildLogBlockId, {
      step: 'Shipper',
      status: 'failed',
      message: `error: ${truncate(errMessage(error), 200)}`,
    });
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Discover context
// ─────────────────────────────────────────────────────────────────────────────

export interface DiscoverContextArgs {
  workspaceId: string;
  buildLogBlockId: string;
  config: WorkflowConfig;
}

/**
 * `discover-context` step — gathers the WorkspaceContext for Schema Smith.
 *
 * Reads workspace context from PlanetScale + lists available databases via
 * `ntn datasources query` (proxied through `WorkflowNtnAdapter`).
 *
 * Returns `null` if the workspace is unknown — the orchestrator turns this
 * into a clean `failed` generation rather than an opaque crash.
 */
export async function discoverContext(args: DiscoverContextArgs): Promise<DiscoveredContext> {
  const { workspaceId, config } = args;

  await safeLog(config, args.buildLogBlockId, {
    step: 'Discover Context',
    status: 'running',
    message: 'reading workspace + databases…',
  });

  const workspace = await config.db.getWorkspaceContext(workspaceId);
  if (workspace === null) {
    throw new Error(`discover-context: workspace ${workspaceId} not found in PlanetScale`);
  }

  const [databases, existingAgents] = await Promise.all([
    config.ntn.listDatabases(workspaceId),
    config.db.listExistingAgents(workspaceId),
  ]);

  const schemaSmithContext: WorkspaceContext = {
    databases,
    existingAgents,
  };

  await safeLog(config, args.buildLogBlockId, {
    step: 'Discover Context',
    status: 'succeeded',
    message: `${databases.length} database(s), ${existingAgents.length} existing agent(s)`,
  });

  return { workspace, schemaSmithContext };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function resolveModelUsed(config: WorkflowConfig): string {
  return (
    config.subAgent.primaryModel ??
    defaultPrimaryModelForProvider(resolvePrimaryProvider(config.subAgent.primaryProvider))
  );
}

interface CapturedSubAgentUsage {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

function createSubAgentTrace(
  config: WorkflowConfig,
  agent: SubAgentCompleteEvent['agent'],
): {
  subAgentConfig: SubAgentConfig;
  complete: () => CapturedSubAgentUsage | null;
} {
  const downstreamLogger = config.subAgent.logger ?? config.logger;
  let completeEvent: CapturedSubAgentUsage | null = null;

  return {
    subAgentConfig: {
      ...config.subAgent,
      logger: {
        info(msg, meta) {
          const captured = captureCompleteEvent(agent, msg, meta);
          if (captured !== null) completeEvent = captured;
          downstreamLogger?.info(msg, meta);
        },
        error(msg, meta) {
          downstreamLogger?.error(msg, meta);
        },
      },
    },
    complete: () => completeEvent,
  };
}

function captureCompleteEvent(
  expectedAgent: SubAgentCompleteEvent['agent'],
  msg: string,
  meta: Record<string, unknown> | undefined,
): CapturedSubAgentUsage | null {
  if (meta === undefined) return null;
  if (meta['agent'] !== expectedAgent) return null;
  if (msg !== `${expectedAgent.replaceAll('_', '-')}.complete`) return null;

  return {
    promptTokens: readFiniteNumber(meta, 'inputTokens'),
    completionTokens: readFiniteNumber(meta, 'outputTokens'),
    cacheReadTokens: readFiniteNumber(meta, 'cacheReadTokens'),
    cacheWriteTokens: readFiniteNumber(meta, 'cacheWriteTokens'),
    costUsd: readFiniteNumber(meta, 'costUsd'),
  };
}

function readFiniteNumber(meta: Record<string, unknown>, key: string): number {
  const value = meta[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Append a Build Log entry, swallowing transport errors so a Notion outage
 * doesn't kill an in-progress generation. Errors are surfaced via the injected
 * logger when present.
 */
async function safeLog(
  config: WorkflowConfig,
  blockId: string,
  entry: {
    step: string;
    status: 'running' | 'succeeded' | 'failed' | 'info';
    message: string;
  },
): Promise<void> {
  try {
    await config.notion.appendBuildLogEntry(blockId as never, {
      ...entry,
      timestamp: new Date(),
    });
  } catch (error) {
    config.logger?.info('workflow.notion-log.swallow', {
      err: errMessage(error),
      step: entry.step,
      status: entry.status,
    });
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Convert any thrown value into a JSON-safe shape suitable for
 * `GenerationStep.errorJson`.
 */
function errorToJson(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      // Some of our sub-agent errors carry a `detail` field — surface it.
      ...((err as unknown as { detail?: unknown }).detail !== undefined && {
        detail: (err as unknown as { detail?: unknown }).detail,
      }),
    };
  }
  return { message: errMessage(err) };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
