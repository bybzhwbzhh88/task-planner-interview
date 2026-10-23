import { defineConfig } from "vitest/config";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test")) {
  throw new Error("Set TEST_DATABASE_URL to a dedicated PostgreSQL database whose name ends in _test.");
}

export default defineConfig({
  test: {
    // Wasp 0.25 validates NODE_ENV as development | production.
    env: { NODE_ENV: "development", DATABASE_URL: databaseUrl },
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
