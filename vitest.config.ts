import { defineConfig } from "vitest/config";

if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL) {
  throw new Error("请使用 TEST_DATABASE_URL=... npm run test:quota 运行独立数据库验收。");
}

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 10_000,
  },
});
