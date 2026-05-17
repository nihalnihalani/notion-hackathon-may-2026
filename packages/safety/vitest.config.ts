import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/types.ts', 'src/allowlists.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        // Per-file thresholds are too brittle for this codebase; the rules
        // are tiny pure functions and one branch can swing 5%. Aim global.
        branches: 85,
        statements: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
