import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/quota.integration.test.ts'],
    environment: 'node',
    env: { NODE_ENV: 'development' },
    testTimeout: 15_000,
    hookTimeout: 15_000,
    reporters: ['verbose'],
  },
});
