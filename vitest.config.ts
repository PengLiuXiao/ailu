import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    // Several discovery tests mutate process.env (AILU_HOME etc.) and share
    // module-level caches; parallel test files race on them and fail
    // intermittently (they pass green when run serially or alone).
    fileParallelism: false,
  },
});
