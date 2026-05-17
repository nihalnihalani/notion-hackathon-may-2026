/**
 * Pure helpers for building Notion rich-text and block payloads.
 *
 * No IO; safe to import anywhere (including agent code that has its own
 * Notion access via the ntn SDK and just needs to author blocks).
 */

import type {
  NotionBlock,
  NotionColor,
  NotionRichText,
} from './types.js';

/** Build a single-segment plain-text rich-text array. */
export function plainText(text: string): NotionRichText[] {
  return [
    {
      type: 'text',
      text: { content: text, link: null },
    },
  ];
}

export function paragraph(text: string, color?: NotionColor): NotionBlock {
  return {
    object: 'block',
    id: '' as NotionBlock['id'],
    type: 'paragraph',
    paragraph: {
      rich_text: plainText(text),
      ...(color === undefined ? {} : { color }),
    },
  };
}

export function heading(level: 1 | 2 | 3, text: string): NotionBlock {
  if (level === 1) {
    return {
      object: 'block',
      id: '' as NotionBlock['id'],
      type: 'heading_1',
      heading_1: { rich_text: plainText(text) },
    };
  }
  if (level === 2) {
    return {
      object: 'block',
      id: '' as NotionBlock['id'],
      type: 'heading_2',
      heading_2: { rich_text: plainText(text) },
    };
  }
  return {
    object: 'block',
    id: '' as NotionBlock['id'],
    type: 'heading_3',
    heading_3: { rich_text: plainText(text) },
  };
}

export function code(text: string, language: string): NotionBlock {
  return {
    object: 'block',
    id: '' as NotionBlock['id'],
    type: 'code',
    code: {
      rich_text: plainText(text),
      language,
    },
  };
}

export function callout(
  text: string,
  emoji?: string,
  color?: NotionColor,
): NotionBlock {
  return {
    object: 'block',
    id: '' as NotionBlock['id'],
    type: 'callout',
    callout: {
      rich_text: plainText(text),
      ...(emoji === undefined ? {} : { icon: { type: 'emoji' as const, emoji } }),
      ...(color === undefined ? {} : { color }),
    },
  };
}

export function divider(): NotionBlock {
  return {
    object: 'block',
    id: '' as NotionBlock['id'],
    type: 'divider',
    divider: {},
  };
}

export function bulletedListItem(text: string): NotionBlock {
  return {
    object: 'block',
    id: '' as NotionBlock['id'],
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: plainText(text) },
  };
}

export function numberedListItem(text: string): NotionBlock {
  return {
    object: 'block',
    id: '' as NotionBlock['id'],
    type: 'numbered_list_item',
    numbered_list_item: { rich_text: plainText(text) },
  };
}

export function toDo(text: string, checked = false): NotionBlock {
  return {
    object: 'block',
    id: '' as NotionBlock['id'],
    type: 'to_do',
    to_do: { rich_text: plainText(text), checked },
  };
}

export function toggle(text: string): NotionBlock {
  return {
    object: 'block',
    id: '' as NotionBlock['id'],
    type: 'toggle',
    toggle: { rich_text: plainText(text) },
  };
}
