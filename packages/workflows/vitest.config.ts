/**
 * Vitest config for @forge/workflows.
 *
 * Mirrors `@forge/agents` — aliases workspace deps to their `src/` entry
 * points so tests can run without a build step. Production `package.json`
 * `exports` still point at `dist/`.
 *
 * The sub-path aliases (`@forge/connectors/anthropic`, etc.) MUST come BEFORE
 * the bare `@forge/connectors` entry — Vite walks the alias list in order
 * and a bare-package match would otherwise swallow the sub-path import.
 */

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      // ── Sub-path entries first (longest-prefix wins) ──────────────────────
      '@forge/connectors/anthropic': r('../connectors/src/anthropic/index.ts'),
      '@forge/connectors/openai': r('../connectors/src/openai/index.ts'),
      '@forge/connectors/minimax': r('../connectors/src/minimax/index.ts'),
      '@forge/db/edge': r('../db/src/edge.ts'),
      '@forge/db/client': r('../db/src/client.ts'),
      '@forge/agents/schema-smith': r('../agents/src/schema-smith.ts'),
      '@forge/agents/tool-coder': r('../agents/src/tool-coder.ts'),
      '@forge/agents/inspector': r('../agents/src/inspector.ts'),
      '@forge/agents/shipper': r('../agents/src/shipper.ts'),
      // ── Bare-package entries ──────────────────────────────────────────────
      '@forge/agents': r('../agents/src/index.ts'),
      '@forge/connectors': r('../connectors/src/index.ts'),
      '@forge/notion-client': r('../notion-client/src/index.ts'),
      '@forge/ntn-wrapper': r('../ntn-wrapper/src/index.ts'),
      // `@forge/db` brings Prisma into the test bundle; tests always inject a
      // mock client (and the workflow code only uses it through injected
      // helpers in `WorkflowConfig`) — but the import must still resolve for
      // type imports.
      '@forge/db': r('../db/src/index.ts'),
    },
  },
});
