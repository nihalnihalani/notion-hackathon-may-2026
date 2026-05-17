/**
 * Vitest config for @forge/eval-harness.
 *
 * Tests live next to source as `*.test.ts` (colocated). The harness is
 * thin glue — coverage targets are deliberately modest because the
 * value here is YAML correctness, not branch density.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/cli.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        branches: 70,
        statements: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
