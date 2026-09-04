import { defineConfig } from 'vitest/config';

// Unit tests only. They cover the pure domain rules in packages/domain and must
// run without Docker, a database, or a network — that is the whole reason the
// domain package has no I/O in it. Everything that needs infrastructure is
// covered by the Playwright suite in e2e/ instead.
export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/domain/src/**'],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
