import { defineConfig } from 'vitest/config';

import { testDatabaseUrl } from './test/helpers/env.js';

/**
 * Tests share one database and truncate between cases, so files run serially.
 * If that ever becomes the bottleneck, the fix is a schema per worker — not
 * parallel truncates against the same tables.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/helpers/globalSetup.ts'],
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl(),
      // Tests must never depend on the developer's real secret.
      JWT_SECRET: 'test_only_secret_value',
    },
  },
});
