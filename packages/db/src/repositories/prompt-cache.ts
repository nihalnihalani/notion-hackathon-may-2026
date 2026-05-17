/**
 * PromptCache repository — read-side helpers for the inter-generation cache
 * that lets us short-circuit Schema Smith + Tool Coder when a semantically
 * similar description has been seen recently.
 *
 * Two lookup modes:
 *
 *   1. `lookupByHash(descriptionHash)` — exact match. Cheap. This is the path
 *      hit by `/api/forge/trigger` when the same workspace asks for the same
 *      description twice.
 *
 *   2. `lookupByEmbedding(embedding, topK)` — semantic KNN over the
 *      pgvector-encoded `PromptCache.embedding` column. This is the path that
 *      lets a *different* description ("triage Linear issues" vs "manage
 *      Linear bug queue") still hit the cache.
 *
 * We do NOT write to PromptCache from this module — the orchestrator handles
 * cache population after a successful generation. Adding writers here would
 * blur the boundary between read-cache and source-of-truth.
 */

import { prisma } from '../client.js';
import type { PromptCache } from '../types.js';

/**
 * Exact-hash lookup against `PromptCache.descriptionHash`. Honors
 * `expiresAt` — entries past their TTL are treated as misses.
 *
 * Returns the most-recently-created live entry on collision (collisions are
 * astronomically unlikely for SHA-256 but we sort defensively).
 */
export async function lookupByHash(descriptionHash: string): Promise<PromptCache | null> {
  return prisma.promptCache.findFirst({
    where: {
      descriptionHash,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Semantic KNN over the pgvector-encoded `embedding` column.
 *
 * STATUS: stub. The Prisma schema declares `embedding` as `Bytes` because
 * Prisma does not (as of 5.22) have first-class pgvector support in its
 * query API. To do real KNN we either:
 *
 *   (a) wire pgvector via a Prisma generator + raw SQL helper, or
 *   (b) do the KNN out-of-band (e.g. via a Vercel KV-backed ANN index).
 *
 * Neither is in scope for this PR — the brief explicitly asks for a typed
 * stub that throws. When PromptCache writes start landing real vectors, we
 * lift the throw and implement option (a) using `prisma.$queryRaw` confined
 * to this single function (the "no raw SQL in repos" rule has one documented
 * exception: pgvector ops, which Prisma has no typed surface for).
 *
 * @throws Always — until pgvector is wired up.
 */
export function lookupByEmbedding(
  _embedding: Float32Array,
  _options?: { topK?: number; minSimilarity?: number },
): Promise<readonly PromptCache[]> {
  return Promise.reject(
    new Error(
      '[@forge/db] lookupByEmbedding: pgvector not configured. ' +
        'See packages/db/src/repositories/prompt-cache.ts for the implementation plan.',
    ),
  );
}
