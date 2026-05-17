/**
 * Vitest config for `@forge/web`.
 *
 * Mirrors the tsconfig `@/*` path alias so test files can import route
 * handlers without relative gymnastics. Node environment is used by default;
 * route-handler tests don't need a DOM.
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['__tests__/**/*.test.ts', 'lib/**/*.test.ts'],
    // Each test file calls vi.resetModules() — keep workers isolated so a
    // mock registered in one file does not leak into another.
    isolate: true,
  },
  resolve: {
    alias: {
      '@/': `${here}/`,
    },
  },
});
