import { defineConfig } from "vitest/config";

// 独立的 vitest 配置：不加载 vite.config.ts，避免在未执行 `wasp compile`
// 的环境里因为 `wasp/client/vite` 不存在而跑不起来。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
