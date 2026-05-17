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
import type {
  BlockId,
  NotionBlock,
  NotionClientConfig,
  NotionRichText,
} from './types.js';

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
 * Wipe the Build Log between generations.
 *
 * We page through `getBlockChildren` and DELETE each one. Notion's delete is
 * a soft-delete (sets `in_trash: true`) so the audit trail is preserved.
 *
 * Note on rate: this is N requests. For a fresh generation we expect ≤30
 * lines, so worst-case ~30 DELETEs — well under the 3 req/sec budget IF the
 * pacer is configured. For very long logs the caller should consider
 * archiving the container itself instead.
 */
export async function clearBuildLog(
  config: NotionClientConfig,
  blockId: BlockId,
): Promise<void> {
  // We collect all children first to avoid mutating during pagination.
  const ids: BlockId[] = [];
  let cursor: string | undefined;
  do {
    const page = await getBlockChildren(config, blockId, {
      ...(cursor === undefined ? {} : { start_cursor: cursor }),
      page_size: 100,
    });
    for (const child of page.results) ids.push(child.id);
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor);

  for (const id of ids) {
    await deleteBlock(config, id);
  }
}
