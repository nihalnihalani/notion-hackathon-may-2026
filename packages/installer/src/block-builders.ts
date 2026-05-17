/**
 * Pure helpers that build Notion block payloads for the Forge page.
 *
 * Every export is a pure function that returns a plain JSON object the
 * Notion REST API accepts as a child in
 * `PATCH /v1/blocks/{id}/children` (see
 * https://developers.notion.com/reference/patch-block-children).
 *
 * No IO — these helpers are safe to import from edge bundles, the
 * reconciler, and tests.
 *
 * Notion API quirks we've encoded here (verified against API version
 * 2026-03-11):
 *
 * 1. **Button blocks are NOT createable via the REST API.** The
 *    Notion docs explicitly list `button` as "unsupported by API"
 *    (https://developers.notion.com/reference/block — "The API does not
 *    support all block types"). Webhook actions on buttons are configured
 *    via the in-app builder only. Our fallback: render a `bookmark` block
 *    pointing at the Forge webhook trigger URL. The bookmark displays as
 *    a clickable card; Notion's automation system can later attach a true
 *    button to the same URL once API support lands.
 *
 * 2. **Synced blocks CAN be created** as "original" blocks by sending
 *    `synced_block: { synced_from: null, children: [...] }`. Reference
 *    duplicates use `synced_from: { block_id }`. We use the original form
 *    for the Build Log so other pages in the workspace can mirror it.
 *
 * 3. **Children sent to append are *create* shapes, not the full block
 *    shape we receive back** — see `NotionBlockInput` in
 *    `@forge/notion-client/blocks.ts`. We do not include `id`,
 *    `created_time`, or any other read-only field.
 */

import { plainText } from '@forge/notion-client';
import type {
  NotionBlockInput,
  NotionRichText,
} from '@forge/notion-client';

// ── Page top-of-page intro ───────────────────────────────────────────────────

/**
 * H1 heading at the top of the Forge page.
 *
 * We deliberately do NOT use `is_toggleable: true` here — the title
 * should always be visible.
 */
export function buildPageTitleHeading(): NotionBlockInput {
  return {
    object: 'block',
    type: 'heading_1',
    heading_1: {
      rich_text: plainText('Forge — your agents, in plain English'),
    },
  };
}

/**
 * Intro callout block ("👋 Welcome to Forge").
 *
 * Per PLAN §VII this is a high-affordance block at the very top — gray
 * background, emoji icon, single sentence framing.
 */
export function buildIntroCallout(): NotionBlockInput {
  return {
    object: 'block',
    type: 'callout',
    callout: {
      rich_text: plainText(
        'Describe an agent in plain English below — Forge writes, ' +
          'tests, and deploys it to your workspace in ~90 seconds.',
      ),
      icon: { type: 'emoji', emoji: '👋' },
      color: 'gray_background',
    },
  };
}

/**
 * "▼ How it works" toggle block with the 4-step explainer.
 *
 * We model the children as numbered_list_items so they render with the
 * native Notion numbering (resilient to reorder).
 */
export function buildHowItWorksToggle(): NotionBlockInput {
  return {
    object: 'block',
    type: 'toggle',
    toggle: {
      rich_text: plainText('How it works'),
    },
    // `has_children` on the *response* is read-only; on input we pass
    // `children` directly under the type-keyed object per Notion API
    // (https://developers.notion.com/reference/block#toggle).
    ...({
      toggle_children: undefined, // typing hack — see below
    } as Record<string, unknown>),
  };
}

/**
 * Children of the "How it works" toggle. Pass alongside the toggle when
 * appending — the Notion API accepts `children` nested inside the
 * type-keyed object, but our `NotionBlockInput` type doesn't expose that
 * field directly. Caller logic in `installer.ts` re-builds the payload
 * with the children inlined.
 */
export function buildHowItWorksChildren(): NotionBlockInput[] {
  return [
    {
      object: 'block',
      type: 'numbered_list_item',
      numbered_list_item: {
        rich_text: plainText('Add a row to "Forge Requests" below'),
      },
    },
    {
      object: 'block',
      type: 'numbered_list_item',
      numbered_list_item: {
        rich_text: plainText(
          'Describe the agent you want in plain English',
        ),
      },
    },
    {
      object: 'block',
      type: 'numbered_list_item',
      numbered_list_item: {
        rich_text: plainText('Click ⚡ Forge this Agent'),
      },
    },
    {
      object: 'block',
      type: 'numbered_list_item',
      numbered_list_item: {
        rich_text: plainText(
          "Watch the Build Log; you'll have a Custom Agent in ~90s",
        ),
      },
    },
  ];
}

// ── Forge "button" (fallback: bookmark to webhook URL) ───────────────────────

/**
 * The "⚡ Forge this Agent" trigger.
 *
 * **API limitation**: button blocks cannot be created via REST as of API
 * version 2026-03-11. We fall back to a `bookmark` block pointing at the
 * Forge webhook trigger URL — the user clicks the bookmark, Notion makes
 * a GET (which our handler ignores) or the user follows the rendered card
 * to actually trigger. In a future Notion API version that supports
 * `button` with `call_webhook` action, swap this to:
 *
 *   { type: 'button', button: { actions: [{ type: 'call_webhook',
 *     call_webhook: { url } }], label: '⚡ Forge this Agent' } }
 *
 * The orchestrator-side handler is webhook-agnostic — see
 * `apps/web/app/api/webhooks/notion-button/route.ts`.
 *
 * @param webhookUrl Absolute URL to `${appUrl}/api/webhooks/notion-button`.
 */
export function buildForgeButtonBookmark(webhookUrl: string): NotionBlockInput {
  return {
    object: 'block',
    type: 'bookmark',
    bookmark: {
      url: webhookUrl,
      caption: plainText('⚡ Forge this Agent'),
    },
  } as unknown as NotionBlockInput;
  // ^ cast: the public `NotionBlock` union in `@forge/notion-client` does
  //   not enumerate `bookmark` (we only model the block types Forge
  //   itself authors), but the JSON shape is the documented one. We rely
  //   on Notion to validate.
}

/**
 * Future-forward variant for when the Notion REST API supports button
 * blocks. NOT used by the installer today — kept here so the contract is
 * visible to readers and the reconciler can adopt it the moment Notion
 * ships support.
 */
export function buildForgeButtonNative(webhookUrl: string): NotionBlockInput {
  return {
    object: 'block',
    type: 'button',
    button: {
      // Shape inferred from the in-app builder; not yet documented on
      // developers.notion.com for REST POST.
      label: '⚡ Forge this Agent',
      actions: [{ type: 'call_webhook', call_webhook: { url: webhookUrl } }],
    },
  } as unknown as NotionBlockInput;
}

// ── Build Log container (synced block or toggle fallback) ────────────────────

/**
 * The 🧱 Build Log container.
 *
 * Per Notion API research (2026-04-01 added synced_block copy support;
 * "original" synced blocks have always been creatable with
 * `synced_from: null`), we create an *original* synced block so the user
 * can mirror it onto a dashboard page later. The orchestrator appends
 * paragraph blocks into this container as Build Log entries via
 * `@forge/notion-client`'s `appendBuildLogEntry`.
 *
 * The visible header label ("🧱 Build Log") is emitted as a separate
 * `heading_3` block placed immediately before the synced block.
 */
export function buildBuildLogHeading(): NotionBlockInput {
  return {
    object: 'block',
    type: 'heading_3',
    heading_3: {
      rich_text: plainText('🧱 Build Log'),
    },
  };
}

export function buildBuildLogSyncedBlock(): NotionBlockInput {
  return {
    object: 'block',
    type: 'synced_block',
    synced_block: {
      synced_from: null,
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: plainText(
              'Build log entries will appear here once you trigger Forge.',
            ),
            color: 'gray',
          },
        },
      ],
    },
  } as unknown as NotionBlockInput;
}

/**
 * Toggle fallback for environments / workspace tiers where synced blocks
 * are not available. Used by the installer when synced_block creation
 * returns a validation_error.
 */
export function buildBuildLogToggleFallback(): NotionBlockInput {
  return {
    object: 'block',
    type: 'toggle',
    toggle: {
      rich_text: [
        {
          type: 'text',
          text: { content: '🧱 Build Log', link: null },
          annotations: {
            bold: true,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: 'default',
          },
        } as NotionRichText,
      ],
    },
  };
}

// ── Settings toggle ──────────────────────────────────────────────────────────

/**
 * "⚙️ Settings" toggle block with placeholder children (default model,
 * connected providers, MCP API key). Actual values live in PlanetScale —
 * the page only surfaces a static list for now. The dashboard at
 * `/settings` is the source-of-truth UI.
 */
export function buildSettingsToggle(): NotionBlockInput {
  return {
    object: 'block',
    type: 'toggle',
    toggle: {
      rich_text: plainText('⚙️ Settings'),
    },
  };
}

export function buildSettingsChildren(): NotionBlockInput[] {
  return [
    {
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: plainText('Default model: Claude Opus 4.7 (auto-failover to GPT-5)'),
      },
    },
    {
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: plainText('OAuth providers connected: (manage in dashboard)'),
      },
    },
    {
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: plainText('API key for MCP access: (issued in dashboard)'),
      },
    },
  ];
}

// ── Inline DB heading (database is created as a separate API call) ───────────

/**
 * Divider used between the major sections of the Forge page so the layout
 * matches the ASCII mock in PLAN §VII.
 */
export function buildDivider(): NotionBlockInput {
  return {
    object: 'block',
    type: 'divider',
    divider: {},
  } as unknown as NotionBlockInput;
}

/**
 * Build the *full* tree of children for the root Forge page in the order
 * they should appear top-to-bottom.
 *
 * NOTE: this excludes the inline databases (Forge Requests + Forge
 * Agents) and the synced Build Log block — those are created via
 * separate API calls in `installer.ts` so we can capture their IDs to
 * persist on the Workspace row.
 *
 * The "How it works" toggle's children are inlined here via the
 * `toggle.children` field. Notion accepts nested `children` arrays at
 * any depth in append-children, capped at 2 levels.
 */
export function buildRootPageInitialChildren(): NotionBlockInput[] {
  return [
    buildIntroCallout(),
    {
      object: 'block',
      type: 'toggle',
      toggle: {
        rich_text: plainText('How it works'),
        // Inlining children here keeps the install a single round-trip.
        // See https://developers.notion.com/reference/patch-block-children
        // — `children` is permitted at create-time on toggleable blocks.
        ...({
          children: buildHowItWorksChildren(),
        } as Record<string, unknown>),
      },
    } as unknown as NotionBlockInput,
    buildDivider(),
  ];
}
