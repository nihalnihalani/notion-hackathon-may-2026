/**
 * Shared types for `@forge/notion-client`.
 *
 * This package is consumed by the Forge studio itself (Vercel Functions,
 * installer scripts, the Build-Log streamer). It is intentionally separate
 * from `@forge/connectors`, which is the surface used by **generated** agents
 * via the `ntn` SDK. Studio code needs deeper Notion REST coverage (pages,
 * blocks, databases, comments, webhooks, search) and may use a different auth
 * token (workspace OAuth) than the per-Worker ntn token.
 *
 * Design rules:
 *  - Pure factories — nothing reads from `process.env`.
 *  - Edge-runtime safe — no `node:*` imports anywhere in the runtime path.
 *  - Native `fetch` by default, but injectable for tests / instrumentation.
 *  - All IDs are branded so callers cannot accidentally pass a `BlockId` where
 *    a `PageId` is required.
 */

// ── Fetch + Logger ───────────────────────────────────────────────────────────

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface Logger {
  debug?: (msg: string, meta?: Record<string, unknown>) => void;
  info?: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  error?: (msg: string, meta?: Record<string, unknown>) => void;
}

// ── Pacer (forward declared — concrete impl in `pacer.ts`) ───────────────────

export interface Pacer {
  /** Resolves when a request slot is available. Token-bucket semantics. */
  acquire(): Promise<void>;
}

// ── Client config ────────────────────────────────────────────────────────────

/**
 * Per-call config. The token is the workspace's Notion API token
 * (either an integration secret `secret_*` or an OAuth access token).
 */
export interface NotionClientConfig {
  token: string;
  /** Defaults to {@link DEFAULT_NOTION_VERSION}. Override for migration tests. */
  notionVersion?: string;
  /** Defaults to `https://api.notion.com`. Override for VCR / proxy. */
  baseUrl?: string;
  /** Inject a fetch impl (tests, instrumentation, alternate runtimes). */
  fetch?: FetchLike;
  /** Optional structured logger; methods missing → silent. */
  logger?: Logger;
  /**
   * Optional in-memory pacer. Notion's sustained limit is ~3 req/sec per
   * integration, so a single Vercel instance can self-throttle here.
   * For multi-region / horizontally-scaled paths you need a distributed
   * pacer (Upstash Redis) at the API-route layer — that's out of scope
   * for this library.
   */
  pacer?: Pacer;
}

// ── Retry ────────────────────────────────────────────────────────────────────

export interface RetryOptions {
  retries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

export const DEFAULT_RETRY: RetryOptions = {
  retries: 3,
  initialDelayMs: 250,
  maxDelayMs: 8000,
  jitter: true,
};

// ── API version ──────────────────────────────────────────────────────────────

/**
 * Latest documented Notion-Version as of 2026-05-17.
 *
 * Source: https://developers.notion.com/reference/versioning ("our latest
 * version is `2026-03-11`"). Pin this constant; do not auto-update — Notion
 * versions are breaking-change boundaries and must be migrated explicitly.
 */
export const DEFAULT_NOTION_VERSION = '2026-03-11';

export const DEFAULT_BASE_URL = 'https://api.notion.com';

// ── Branded IDs ──────────────────────────────────────────────────────────────

export type PageId = string & { readonly __brand: 'PageId' };
export type BlockId = string & { readonly __brand: 'BlockId' };
export type DatabaseId = string & { readonly __brand: 'DatabaseId' };
export type UserId = string & { readonly __brand: 'UserId' };
export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' };
export type CommentId = string & { readonly __brand: 'CommentId' };
export type PropertyId = string & { readonly __brand: 'PropertyId' };

/** Cast helpers (no validation — Notion IDs are UUID v4 or hyphenless). */
export const asPageId = (id: string): PageId => id as PageId;
export const asBlockId = (id: string): BlockId => id as BlockId;
export const asDatabaseId = (id: string): DatabaseId => id as DatabaseId;
export const asUserId = (id: string): UserId => id as UserId;
export const asWorkspaceId = (id: string): WorkspaceId => id as WorkspaceId;
export const asCommentId = (id: string): CommentId => id as CommentId;
export const asPropertyId = (id: string): PropertyId => id as PropertyId;

// ── Common embedded shapes ───────────────────────────────────────────────────

export interface NotionAnnotations {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  code: boolean;
  color: NotionColor;
}

export type NotionColor =
  | 'default'
  | 'gray'
  | 'brown'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red'
  | 'gray_background'
  | 'brown_background'
  | 'orange_background'
  | 'yellow_background'
  | 'green_background'
  | 'blue_background'
  | 'purple_background'
  | 'pink_background'
  | 'red_background';

export interface NotionTextContent {
  content: string;
  link: { url: string } | null;
}

export interface NotionRichText {
  type: 'text';
  text: NotionTextContent;
  annotations?: NotionAnnotations;
  plain_text?: string;
  href?: string | null;
}

export type NotionIcon =
  | { type: 'emoji'; emoji: string }
  | { type: 'external'; external: { url: string } }
  | { type: 'file'; file: { url: string; expiry_time?: string } };

export type NotionParent =
  | { type: 'page_id'; page_id: string }
  | { type: 'database_id'; database_id: string }
  | { type: 'block_id'; block_id: string }
  | { type: 'workspace'; workspace: true };

// ── Block union ──────────────────────────────────────────────────────────────

export interface NotionBlockBase {
  object: 'block';
  id: BlockId;
  parent?: NotionParent;
  created_time?: string;
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
  has_children?: boolean;
}

export type NotionBlock =
  | (NotionBlockBase & {
      type: 'paragraph';
      paragraph: { rich_text: NotionRichText[]; color?: NotionColor };
    })
  | (NotionBlockBase & {
      type: 'heading_1';
      heading_1: {
        rich_text: NotionRichText[];
        color?: NotionColor;
        is_toggleable?: boolean;
      };
    })
  | (NotionBlockBase & {
      type: 'heading_2';
      heading_2: {
        rich_text: NotionRichText[];
        color?: NotionColor;
        is_toggleable?: boolean;
      };
    })
  | (NotionBlockBase & {
      type: 'heading_3';
      heading_3: {
        rich_text: NotionRichText[];
        color?: NotionColor;
        is_toggleable?: boolean;
      };
    })
  | (NotionBlockBase & {
      type: 'callout';
      callout: {
        rich_text: NotionRichText[];
        icon?: NotionIcon;
        color?: NotionColor;
      };
    })
  | (NotionBlockBase & {
      type: 'code';
      code: {
        rich_text: NotionRichText[];
        language: string;
        caption?: NotionRichText[];
      };
    })
  | (NotionBlockBase & { type: 'divider'; divider: Record<string, never> })
  | (NotionBlockBase & {
      type: 'toggle';
      toggle: { rich_text: NotionRichText[]; color?: NotionColor };
    })
  | (NotionBlockBase & {
      type: 'bulleted_list_item';
      bulleted_list_item: { rich_text: NotionRichText[]; color?: NotionColor };
    })
  | (NotionBlockBase & {
      type: 'numbered_list_item';
      numbered_list_item: { rich_text: NotionRichText[]; color?: NotionColor };
    })
  | (NotionBlockBase & {
      type: 'to_do';
      to_do: {
        rich_text: NotionRichText[];
        checked: boolean;
        color?: NotionColor;
      };
    })
  | (NotionBlockBase & {
      type: 'button';
      button: Record<string, unknown>;
    })
  | (NotionBlockBase & {
      type: 'child_database';
      child_database: { title: string };
    });

export type NotionBlockType = NotionBlock['type'];

// ── Property values (union over Notion property variants) ────────────────────

export type NotionPropertyValue =
  | { id: string; type: 'title'; title: NotionRichText[] }
  | { id: string; type: 'rich_text'; rich_text: NotionRichText[] }
  | { id: string; type: 'number'; number: number | null }
  | {
      id: string;
      type: 'select';
      select: { id?: string; name: string; color?: NotionColor } | null;
    }
  | {
      id: string;
      type: 'multi_select';
      multi_select: { id?: string; name: string; color?: NotionColor }[];
    }
  | {
      id: string;
      type: 'status';
      status: { id?: string; name: string; color?: NotionColor } | null;
    }
  | {
      id: string;
      type: 'date';
      date: {
        start: string;
        end?: string | null;
        time_zone?: string | null;
      } | null;
    }
  | { id: string; type: 'checkbox'; checkbox: boolean }
  | { id: string; type: 'url'; url: string | null }
  | { id: string; type: 'email'; email: string | null }
  | { id: string; type: 'phone_number'; phone_number: string | null }
  | {
      id: string;
      type: 'people';
      people: { object: 'user'; id: string }[];
    }
  | {
      id: string;
      type: 'files';
      files: (
        | { name: string; type: 'external'; external: { url: string } }
        | {
            name: string;
            type: 'file';
            file: { url: string; expiry_time: string };
          }
      )[];
    }
  | {
      id: string;
      type: 'relation';
      relation: { id: string }[];
      has_more?: boolean;
    }
  | {
      id: string;
      type: 'rollup';
      rollup: {
        type: 'number' | 'date' | 'array' | 'unsupported' | 'incomplete';
        number?: number | null;
        date?: { start: string; end?: string | null } | null;
        array?: unknown[];
        function: string;
      };
    }
  | { id: string; type: 'formula'; formula: NotionFormulaValue }
  | { id: string; type: 'created_time'; created_time: string }
  | {
      id: string;
      type: 'created_by';
      created_by: { object: 'user'; id: string };
    }
  | { id: string; type: 'last_edited_time'; last_edited_time: string }
  | {
      id: string;
      type: 'last_edited_by';
      last_edited_by: { object: 'user'; id: string };
    }
  | {
      id: string;
      type: 'unique_id';
      unique_id: { number: number; prefix: string | null };
    }
  | {
      id: string;
      type: 'verification';
      verification: { state: 'verified' | 'unverified' | 'expired' } | null;
    };

export type NotionFormulaValue =
  | { type: 'string'; string: string | null }
  | { type: 'number'; number: number | null }
  | { type: 'boolean'; boolean: boolean | null }
  | { type: 'date'; date: { start: string; end?: string | null } | null };

// ── Page / Database / User / Comment ─────────────────────────────────────────

export interface NotionPage {
  object: 'page';
  id: PageId;
  created_time: string;
  last_edited_time: string;
  created_by: { object: 'user'; id: string };
  last_edited_by: { object: 'user'; id: string };
  cover: NotionIcon | null;
  icon: NotionIcon | null;
  parent: NotionParent;
  archived: boolean;
  in_trash?: boolean;
  properties: Record<string, NotionPropertyValue>;
  url: string;
  public_url: string | null;
}

export interface NotionDatabase {
  object: 'database';
  id: DatabaseId;
  created_time: string;
  last_edited_time: string;
  title: NotionRichText[];
  description: NotionRichText[];
  icon: NotionIcon | null;
  cover: NotionIcon | null;
  parent: NotionParent;
  archived: boolean;
  in_trash?: boolean;
  /** Property *schema* (not values) keyed by property name. */
  properties: Record<string, NotionDatabasePropertySchema>;
  url: string;
  is_inline?: boolean;
  public_url?: string | null;
}

/** Property schema entries on a database — variant is identified by `type`. */
export interface NotionDatabasePropertySchema {
  id: string;
  name: string;
  type: string;
  // Notion includes type-specific config objects keyed by the type name.
  // We use a permissive shape because the surface is huge and most callers
  // either read by name or pass back through `updateDatabase` opaquely.
  [k: string]: unknown;
}

export type NotionUser =
  | {
      object: 'user';
      id: UserId;
      type: 'person';
      name: string | null;
      avatar_url: string | null;
      person: { email?: string };
    }
  | {
      object: 'user';
      id: UserId;
      type: 'bot';
      name: string | null;
      avatar_url: string | null;
      bot: {
        owner?:
          | { type: 'workspace'; workspace: true }
          | { type: 'user'; user: { object: 'user'; id: string } };
        workspace_name?: string | null;
      };
    };

export interface NotionComment {
  object: 'comment';
  id: CommentId;
  parent: { type: 'page_id'; page_id: string } | { type: 'block_id'; block_id: string };
  discussion_id: string;
  created_time: string;
  last_edited_time: string;
  created_by: { object: 'user'; id: string };
  rich_text: NotionRichText[];
}

// ── Paginated response envelope ──────────────────────────────────────────────

export interface NotionPaginated<T> {
  object: 'list';
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
  type?: string;
  page_or_database?: Record<string, never>;
}
