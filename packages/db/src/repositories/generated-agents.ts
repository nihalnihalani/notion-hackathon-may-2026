/**
 * GeneratedAgent repository — typed query helpers for the deployed-agent
 * records that back the dashboard's Forge Agents view.
 *
 * "Soft delete" model: we never hard-delete a GeneratedAgent row. Instead we
 * flip `status` to `retracted`. This preserves the audit trail (an
 * `agent.deleted` event in `AuditLog` is meaningless without the row it
 * referred to) and keeps `Generation.agentId` FKs stable.
 */

import { prisma } from "../client.js";
import type {
  AgentPattern,
  AgentStatus,
  GeneratedAgent,
  Prisma,
} from "../types.js";

/**
 * Create a freshly deployed agent. Called by Shipper after `ntn workers
 * deploy` succeeds.
 */
export async function createGeneratedAgent(input: {
  workspaceId: string;
  generationId: string;
  ntnWorkerName: string;
  ntnDeployUrl?: string | null;
  notionCustomAgentId?: string | null;
  pattern: AgentPattern;
  description: string;
  sourceBlobUrl: string;
  avatarUrl?: string | null;
  capabilities: Prisma.InputJsonValue;
  oauthProviders: readonly string[];
  webhookUrl?: string | null;
}): Promise<GeneratedAgent> {
  return prisma.generatedAgent.create({
    data: {
      workspaceId: input.workspaceId,
      generationId: input.generationId,
      ntnWorkerName: input.ntnWorkerName,
      ntnDeployUrl: input.ntnDeployUrl ?? null,
      notionCustomAgentId: input.notionCustomAgentId ?? null,
      pattern: input.pattern,
      description: input.description,
      sourceBlobUrl: input.sourceBlobUrl,
      avatarUrl: input.avatarUrl ?? null,
      capabilities: input.capabilities,
      oauthProviders: [...input.oauthProviders],
      webhookUrl: input.webhookUrl ?? null,
      status: "active",
    },
  });
}

/**
 * List `active` and `paused` agents for the workspace. Excludes `retracted`
 * (soft-deleted) entries; pass `includeRetracted` to override.
 */
export async function findActiveAgentsByWorkspace(
  workspaceId: string,
  options?: { includeRetracted?: boolean },
): Promise<GeneratedAgent[]> {
  return prisma.generatedAgent.findMany({
    where: {
      workspaceId,
      ...(options?.includeRetracted
        ? {}
        : { status: { in: ["active", "paused"] } }),
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Move an agent between `active` and `paused`. Use `softDeleteAgent` for
 * retraction — keeping that as a separate function makes audit-event mapping
 * unambiguous at the call site.
 */
export async function markAgentStatus(
  id: string,
  status: Exclude<AgentStatus, "retracted">,
): Promise<GeneratedAgent> {
  return prisma.generatedAgent.update({
    where: { id },
    data: { status },
  });
}

/**
 * Retract an agent (status → `retracted`). Does NOT delete the row, does NOT
 * call the upstream NTN delete — that's the caller's responsibility (and the
 * call site should emit an `agent.deleted` audit event after the NTN delete
 * succeeds).
 */
export async function softDeleteAgent(id: string): Promise<GeneratedAgent> {
  return prisma.generatedAgent.update({
    where: { id },
    data: { status: "retracted" },
  });
}
