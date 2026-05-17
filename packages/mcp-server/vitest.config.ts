/**
 * Vitest config for @forge/mcp-server.
 *
 * `resolve.alias` shims the workspace dependencies to their `src/` entry
 * points so tests run without a build step. This mirrors the pattern used
 * by `@forge/agents` and keeps the production `package.json` `exports` map
 * pointing at `dist/` as usual.
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
      // `@forge/db` is type-only for this package — tests inject mock
      // implementations of the `ForgeMcpConfig` callbacks, so we just need
      // the import to resolve. Source entry point avoids needing a build.
      '@forge/db': r('../db/src/index.ts'),
      '@forge/workflows': r('../workflows/src/index.ts'),
    },
  },
});
