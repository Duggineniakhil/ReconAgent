import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // No rate limiting or real backoff against the fake model
    env: { NODE_ENV: 'test', GEMINI_RPM: '0', GEMINI_RETRY_BASE_MS: '1' },
    // Integration tests share one database
    fileParallelism: false,
  },
});
