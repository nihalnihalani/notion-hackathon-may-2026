/**
 * Helpers for the live "Build Log" block in the user's Forge page.
 *
 * The orchestrator (Vercel Workflow steps) emits structured events; the
 * `/api/forge/log` Vercel function calls {@link appendBuildLogEntry} to push
 * each one into Notion as a paragraph block under the Build Log container.
 *
 * Per PLAN §VII.Build Log streaming:
 *  - Updates are rate-limited to 1 per 500ms per generation at the API-route
 *    layer (this library does not implement that — the pacer here only
 *    protects the 3-req/sec sustained limit globally).
 *  - On generation complete the row in Forge Requests gets Status updated
 *    atomically; that's handled by the orchestrator, not here.
 *
 * Block shape used:
 *
 *   {
 *     type: 'paragraph',
 *     paragraph: {
 *       rich_text: [
 *         { type: 'text', text: { content: '🟢 12:01:03  ' } },
 *         { type: 'text', text: { content: 'Schema Smith: pattern = …' } },
 *       ]
 *     }
 *   }
 */

import { appendBlocks, getBlockChildren, deleteBlock } from './blocks.js';
import { asBlockId } from './types.js';
import type { BlockId, NotionBlock, NotionClientConfig, NotionRichText } from './types.js';

export type BuildLogStatus = 'running' | 'succeeded' | 'failed' | 'info';

export interface BuildLogEntry {
  step: string;
  status: BuildLogStatus;
  message: string;
  timestamp: Date;
}

const STATUS_ICON: Record<BuildLogStatus, string> = {
  running: '⏳',
  succeeded: '✅',
  failed: '❌',
  info: '🔵',
};

/** `HH:MM:SS` in UTC. The user's local-time formatting belongs in the UI
 *  layer — this string is part of the persisted block. */
function formatTimestamp(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Build the rich-text array for a single Build Log entry. */
export function buildLogRichText(entry: BuildLogEntry): NotionRichText[] {
  const icon = STATUS_ICON[entry.status];
  const stamp = formatTimestamp(entry.timestamp);
  return [
    {
      type: 'text',
      text: { content: `${icon} ${stamp}  `, link: null },
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: true,
        color: 'gray',
      },
    },
    {
      type: 'text',
      text: { content: `${entry.step}: ${entry.message}`, link: null },
      annotations: {
        bold: entry.status === 'failed',
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: entry.status === 'failed' ? 'red' : 'default',
      },
    },
  ];
}

/** Build the paragraph-block payload for {@link appendBlocks}. */
export function buildLogBlock(entry: BuildLogEntry): {
  object: 'block';
  type: 'paragraph';
  paragraph: { rich_text: NotionRichText[] };
} {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: buildLogRichText(entry) },
  };
}

/**
 * Append a single Build Log line to the given container block.
 *
 * Returns `void` — callers don't need the new block's id (we never edit
 * past entries; the log is append-only). Errors propagate as
 * {@link NotionError} subclasses.
 */
export async function appendBuildLogEntry(
  config: NotionClientConfig,
  blockId: BlockId,
  entry: BuildLogEntry,
): Promise<void> {
  await appendBlocks(config, blockId, [
    // Casting via unknown — `appendBlocks` accepts NotionBlockInput which
    // requires `type`. Our literal already has it; the cast strips the
    // `id`-less mismatch from the create-vs-read shape.
    buildLogBlock(entry) as unknown as NotionBlock,
  ]);
}

/**
 * Wipe the Build Log between generations — O(1) variant.
 *
 * Strategy: archive the existing container block (1 DELETE), then create a
 * fresh empty container under the same parent page (1 PATCH /children).
 * Returns the new container's BlockId so the caller can persist it back to
 * the workspace row.
 *
 * Why this is O(1): regardless of how many entries the old container held
 * (10 or 10_000), we issue exactly two Notion requests. The previous
 * implementation paged through children and issued one DELETE per entry,
 * which under the 3-req/sec sustained rate limit means a 300-entry log
 * takes >100 s to wipe — far over the Notion webhook 30 s budget.
 *
 * Trade-off: archiving the toggle drops the prior log's reference id and
 * its in-trash audit chain is now anchored to the archived container, not
 * to individual entries. Forge's between-generation reset semantics WANT
 * a clean slate, so this is intentional. Callers who need to preserve N
 * recent entries (e.g. live tail during a re-run) should use
 * {@link keepRecentBuildLogEntries} instead.
 *
 * @param config - Notion client config (auth, fetch, etc.)
 * @param containerBlockId - The current build log container (toggle/synced).
 * @param parentBlockId - The page (or other parent) the new container will
 *                        be created under. Required because Notion does not
 *                        support re-parenting; we must create a fresh
 *                        child on the same parent.
 * @param newContainer - Block creation payload for the fresh container.
 *                       Defaults to an empty toggle named "Build Log".
 * @returns The BlockId of the newly-created container.
 */
export async function clearBuildLog(
  config: NotionClientConfig,
  containerBlockId: BlockId,
  parentBlockId: BlockId,
  newContainer?: {
    type: 'toggle' | 'synced_block' | 'paragraph';
    payload: Record<string, unknown>;
  },
): Promise<BlockId> {
  // 1 request: archive the existing container (soft-delete, in_trash:true).
  await deleteBlock(config, containerBlockId);

  // 1 request: create a fresh container as a child of `parentBlockId`.
  const created = await appendBlocks(config, parentBlockId, [
    buildContainerBlock(newContainer) as unknown as NotionBlock,
  ]);
  const fresh = created.results[0];
  if (!fresh) {
    throw new Error(
      'clearBuildLog: Notion returned an empty results[] from PATCH /blocks/{parent}/children',
    );
  }
  return asBlockId(fresh.id);
}

/**
 * Default empty Build Log container — a collapsed toggle titled "Build Log".
 * Matches the shape the installer creates on first install.
 */
function buildContainerBlock(override?: {
  type: 'toggle' | 'synced_block' | 'paragraph';
  payload: Record<string, unknown>;
}): { object: 'block'; type: string; [k: string]: unknown } {
  if (override) {
    return { object: 'block', type: override.type, [override.type]: override.payload };
  }
  return {
    object: 'block',
    type: 'toggle',
    toggle: {
      rich_text: [{ type: 'text', text: { content: 'Build Log', link: null } }],
      children: [],
    },
  };
}

/**
 * Trim the Build Log container to its `keepLast` most-recent entries.
 *
 * Use this when the audit trail of older entries must be preserved across
 * resets — e.g. a re-run of a previous generation that still wants the
 * earlier attempt visible above the new lines.
 *
 * Cost: O(n) — one GET to list children (paginated, so possibly several
 * GETs) plus one DELETE per entry being trimmed. If you don't need to
 * keep history, prefer {@link clearBuildLog} which is O(1).
 *
 * @param config - Notion client config.
 * @param containerBlockId - The build log container to trim.
 * @param keepLast - Number of most-recent entries to retain (>=0). When 0,
 *                   behaves like the legacy clear-all-children behavior
 *                   (still O(n) — use {@link clearBuildLog} instead).
 */
export async function keepRecentBuildLogEntries(
  config: NotionClientConfig,
  containerBlockId: BlockId,
  keepLast: number,
): Promise<void> {
  if (keepLast < 0) {
    throw new Error(`keepRecentBuildLogEntries: keepLast must be >= 0, got ${String(keepLast)}`);
  }

  // Collect all children first to avoid mutating during pagination.
  const ids: BlockId[] = [];
  let cursor: string | undefined;
  do {
    const page = await getBlockChildren(config, containerBlockId, {
      ...(cursor === undefined ? {} : { start_cursor: cursor }),
      page_size: 100,
    });
    for (const child of page.results) ids.push(child.id);
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor);

  // Notion returns children in insertion order; the last `keepLast` are
  // the most recent. Everything before that gets archived.
  const toArchive = keepLast === 0 ? ids : ids.slice(0, Math.max(0, ids.length - keepLast));
  for (const id of toArchive) {
    await deleteBlock(config, id);
  }
}
