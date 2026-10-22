import { defineConfig } from "vitest/config";

// 只跑 tests/ 下的用例：src 里的代码依赖 Wasp 生成的 SDK，单测只覆盖不依赖运行的额度逻辑。
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
