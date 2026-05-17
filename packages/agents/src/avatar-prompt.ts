/**
 * Pure helper that derives the prompt used for MiniMax avatar generation
 * during the Shipper stage (PLAN.md §IV.4 step 7).
 *
 * Output discipline:
 *
 *  - Brand-consistent: soft purple gradient + minimalist isometric icon style.
 *    Forge's brand mark is purple, so generated avatars match the dashboard
 *    palette without per-agent tuning.
 *
 *  - Pattern-keyed accent: each {@link AgentPattern} maps to a distinct
 *    iconographic noun (a database stack for `database-query`, a lightning bolt
 *    for `webhook-trigger`, etc.) so a glance at the avatar gallery in
 *    Settings → Agents reveals the agent's shape, not just its name.
 *
 *  - Length bounded: descriptions can be long (PLAN.md hard cap is ~500 chars
 *    in the Forge Requests DB). MiniMax image-01 ignores prompts past ~600
 *    chars and a long prompt produces a less coherent image; we truncate the
 *    description to 240 chars before splicing it in.
 *
 *  - Deterministic: this is a pure string-template function. Same inputs →
 *    same prompt. No randomness, no model calls, no network. Suitable for use
 *    in deterministic snapshot tests.
 */

import type { AgentPattern } from './types.js';

/**
 * Hard cap on the user description spliced into the prompt. Keeps the total
 * prompt comfortably under MiniMax's effective attention window even when the
 * surrounding template grows.
 */
const MAX_DESCRIPTION_CHARS = 240;

/**
 * Mapping from each supported {@link AgentPattern} to a short visual motif the
 * model can render. Picked to be visually distinct at 64×64 (the avatar's
 * effective display size in Notion).
 */
const PATTERN_MOTIFS: Readonly<Record<AgentPattern, string>> = {
  'database-query': 'a small stack of database disks with a magnifying glass',
  'webhook-trigger': 'a lightning bolt arcing into a softly glowing inbox',
  'sync-source': 'two circular arrows looping between a cloud and a notebook',
  'external-api-call': 'a hexagonal plug fitting into a labeled socket',
  'multi-step': 'three connected nodes forming a flow chart on a card',
};

/**
 * Truncate a string to at most `max` characters, appending an ellipsis when
 * truncated. Operates on JS code units (sufficient for the BMP-only
 * descriptions Forge accepts).
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Leave room for the ellipsis so the visible length stays within `max`.
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Build a brand-consistent MiniMax image prompt for the given agent.
 *
 * Pure function — same inputs always produce the same prompt. Safe to memoize
 * by the caller if generated repeatedly within a single Shipper run (the
 * Shipper invokes this exactly once per generation, so memoization isn't
 * built in here).
 *
 * @param description Free-text description typed by the user. Whitespace is
 *   collapsed and the value is truncated to {@link MAX_DESCRIPTION_CHARS} so
 *   long prompts do not blow past MiniMax's attention budget.
 * @param pattern The resolved {@link AgentPattern} from Schema Smith.
 */
export function deriveAvatarPrompt(description: string, pattern: AgentPattern): string {
  // Normalize whitespace so accidental newlines + tabs in the user's
  // description don't bloat the prompt or break the template.
  const normalized = description.replace(/\s+/gu, ' ').trim();
  const safeDescription =
    normalized.length === 0
      ? 'a helpful Notion agent'
      : truncate(normalized, MAX_DESCRIPTION_CHARS);
  const motif = PATTERN_MOTIFS[pattern];

  return [
    `Minimalist isometric icon for a Notion agent that ${safeDescription}.`,
    `Visual motif: ${motif}.`,
    'Style: flat vector design, soft purple gradient background (#A78BFA → #6D28D9),',
    'rounded corners, single focal subject, crisp edges, no text, no logos,',
    'no people, no faces. Square composition, centred, 512x512.',
  ].join(' ');
}
