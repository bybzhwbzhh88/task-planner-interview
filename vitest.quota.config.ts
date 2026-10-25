import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("请设置 TEST_DATABASE_URL，指向已初始化的独立 PostgreSQL 测试数据库。");
}

export default defineConfig({
  resolve: {
    alias: [{
      find: /^wasp\/server$/,
      replacement: fileURLToPath(new URL("./tests/wasp-server.ts", import.meta.url)),
    }],
  },
  test: {
    include: ["tests/quota.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
