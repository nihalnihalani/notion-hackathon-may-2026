/**
 * Vitest config for @forge/agents.
 *
 * `resolve.alias` shims the workspace dependencies to their `src/` entry
 * points so tests run without a build step. This is testing-only — the
 * production `package.json` `exports` map points to `dist/` as usual.
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
      '@forge/connectors/anthropic': r('../connectors/src/anthropic/index.ts'),
      '@forge/connectors/openai': r('../connectors/src/openai/index.ts'),
      '@forge/connectors/minimax': r('../connectors/src/minimax/index.ts'),
      '@forge/connectors': r('../connectors/src/index.ts'),
      '@forge/ntn-wrapper': r('../ntn-wrapper/src/index.ts'),
      '@forge/notion-client': r('../notion-client/src/index.ts'),
      // `@forge/db` brings Prisma into the test bundle; tests always inject
      // a mock client, so the real import only needs to resolve for `type`
      // imports + the `recordAuditEvent` / `recordUsage` symbol references.
      // We alias to the source entry point so tests run without a build step.
      '@forge/db': r('../db/src/index.ts'),
    },
  },
});
