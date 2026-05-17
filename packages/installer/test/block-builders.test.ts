import { describe, expect, it } from 'vitest';

import {
  buildBuildLogHeading,
  buildBuildLogSyncedBlock,
  buildBuildLogToggleFallback,
  buildDivider,
  buildForgeButtonBookmark,
  buildForgeButtonNative,
  buildHowItWorksChildren,
  buildIntroCallout,
  buildPageTitleHeading,
  buildRootPageInitialChildren,
  buildSettingsChildren,
  buildSettingsToggle,
} from '../src/block-builders.js';

describe('block-builders — shape conformance to Notion REST', () => {
  it('buildPageTitleHeading returns a heading_1 block', () => {
    const b = buildPageTitleHeading() as { type: string; heading_1: { rich_text: Array<{ text: { content: string } }> } };
    expect(b.type).toBe('heading_1');
    expect(b.heading_1.rich_text[0]!.text.content).toMatch(/Forge/);
  });

  it('buildIntroCallout has gray_background + emoji icon', () => {
    const b = buildIntroCallout() as {
      type: string;
      callout: { color: string; icon: { type: string; emoji: string } };
    };
    expect(b.type).toBe('callout');
    expect(b.callout.color).toBe('gray_background');
    expect(b.callout.icon.type).toBe('emoji');
    expect(b.callout.icon.emoji).toBe('👋');
  });

  it('buildHowItWorksChildren is a 4-step numbered list', () => {
    const c = buildHowItWorksChildren();
    expect(c).toHaveLength(4);
    for (const item of c) {
      expect((item as { type: string }).type).toBe('numbered_list_item');
    }
  });

  it('buildSettingsToggle + children render to a toggle with bullets', () => {
    const t = buildSettingsToggle() as { type: string; toggle: { rich_text: Array<{ text: { content: string } }> } };
    expect(t.type).toBe('toggle');
    expect(t.toggle.rich_text[0]!.text.content).toContain('Settings');
    const c = buildSettingsChildren();
    expect(c.length).toBeGreaterThanOrEqual(3);
    for (const item of c) {
      expect((item as { type: string }).type).toBe('bulleted_list_item');
    }
  });

  it('buildDivider returns a divider block', () => {
    const d = buildDivider() as { type: string; divider: Record<string, never> };
    expect(d.type).toBe('divider');
    expect(d.divider).toEqual({});
  });

  it('buildBuildLogHeading is heading_3', () => {
    const h = buildBuildLogHeading() as { type: string; heading_3: { rich_text: Array<{ text: { content: string } }> } };
    expect(h.type).toBe('heading_3');
    expect(h.heading_3.rich_text[0]!.text.content).toMatch(/Build Log/);
  });

  it('buildBuildLogSyncedBlock creates an ORIGINAL synced block (synced_from = null)', () => {
    // Reference: https://developers.notion.com/reference/block#synced-block
    // An "original" synced block has synced_from === null. Reference blocks
    // have synced_from: { block_id }.
    const b = buildBuildLogSyncedBlock() as {
      type: string;
      synced_block: { synced_from: null; children: unknown[] };
    };
    expect(b.type).toBe('synced_block');
    expect(b.synced_block.synced_from).toBeNull();
    expect(Array.isArray(b.synced_block.children)).toBe(true);
    expect(b.synced_block.children.length).toBeGreaterThan(0);
  });

  it('buildBuildLogToggleFallback is a toggle (for synced_block fallback paths)', () => {
    const t = buildBuildLogToggleFallback() as { type: string };
    expect(t.type).toBe('toggle');
  });

  it('buildForgeButtonBookmark embeds the webhook URL', () => {
    const url = 'https://forge.example/api/webhooks/notion-button?ws=abc';
    const b = buildForgeButtonBookmark(url) as {
      type: string;
      bookmark: { url: string; caption: unknown[] };
    };
    expect(b.type).toBe('bookmark');
    expect(b.bookmark.url).toBe(url);
    expect(b.bookmark.caption.length).toBeGreaterThan(0);
  });

  it('buildForgeButtonNative is a button block (future-forward, not yet used)', () => {
    const url = 'https://forge.example/api/webhooks/notion-button';
    const b = buildForgeButtonNative(url) as {
      type: string;
      button: {
        label: string;
        actions: Array<{ type: string; call_webhook: { url: string } }>;
      };
    };
    expect(b.type).toBe('button');
    expect(b.button.label).toContain('Forge');
    expect(b.button.actions[0]!.type).toBe('call_webhook');
    expect(b.button.actions[0]!.call_webhook.url).toBe(url);
  });

  it('buildRootPageInitialChildren orders intro → toggle → divider', () => {
    const children = buildRootPageInitialChildren();
    expect((children[0] as { type: string }).type).toBe('callout');
    expect((children[1] as { type: string }).type).toBe('toggle');
    expect((children[2] as { type: string }).type).toBe('divider');
  });

  it('buildRootPageInitialChildren inlines the "How it works" children on the toggle', () => {
    const children = buildRootPageInitialChildren();
    const toggle = children[1] as unknown as {
      toggle: { children: Array<{ type: string }> };
    };
    expect(toggle.toggle.children).toHaveLength(4);
    expect(toggle.toggle.children[0]!.type).toBe('numbered_list_item');
  });
});
