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
      '@forge/connectors': r('../connectors/src/index.ts'),
    },
  },
});
