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
 *   2. `lookupByEmbedding(embedding, options)` — semantic KNN over the
 *      Float32-encoded `PromptCache.embedding` column. This is the path that
 *      lets a *different* description ("triage Linear issues" vs "manage
 *      Linear bug queue") still hit the cache.
 *
 * We do NOT write to PromptCache from this module — the orchestrator handles
 * cache population after a successful generation. Adding writers here would
 * blur the boundary between read-cache and source-of-truth.
 */

import { prisma } from '../client.js';
import type { PromptCache } from '../types.js';

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 25;
const DEFAULT_MIN_SIMILARITY = 0.82;
const MAX_CANDIDATES = 1000;

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
 * Semantic KNN over live PromptCache rows.
 *
 * Prisma does not expose first-class pgvector operators here, so production
 * stores embeddings as little-endian Float32 bytes and this read path computes
 * cosine similarity in-process over the newest live cache rows. That keeps the
 * feature working without raw SQL. If cache volume grows beyond this bounded
 * scan, the implementation can move behind the same function to a native ANN
 * index without changing callers.
 */
export async function lookupByEmbedding(
  embedding: Float32Array,
  options?: { topK?: number; minSimilarity?: number },
): Promise<readonly PromptCache[]> {
  if (embedding.length === 0) return [];

  const topK = clampInt(options?.topK ?? DEFAULT_TOP_K, 1, MAX_TOP_K);
  const minSimilarity = clampNumber(options?.minSimilarity ?? DEFAULT_MIN_SIMILARITY, -1, 1);

  const rows = await prisma.promptCache.findMany({
    where: {
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_CANDIDATES,
  });

  return rows
    .map((row) => {
      const candidate = decodeFloat32Embedding(row.embedding);
      if (candidate === null || candidate.length !== embedding.length) return null;
      const similarity = cosineSimilarity(embedding, candidate);
      return similarity >= minSimilarity ? { row, similarity } : null;
    })
    .filter((hit): hit is { row: PromptCache; similarity: number } => hit !== null)
    .sort((a, b) => {
      const bySimilarity = b.similarity - a.similarity;
      if (bySimilarity !== 0) return bySimilarity;
      return b.row.createdAt.getTime() - a.row.createdAt.getTime();
    })
    .slice(0, topK)
    .map((hit) => hit.row);
}

function decodeFloat32Embedding(bytes: Uint8Array): Float32Array | null {
  if (bytes.byteLength === 0 || bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
  for (const index of out.keys()) {
    out[index] = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
  }
  return out;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [index, av] of a.entries()) {
    const bv = b[index] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
