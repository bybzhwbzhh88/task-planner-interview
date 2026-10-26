import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // 生产构建里 wasp/server 由 Wasp 生成，单测用不到这条链路，
      // 换成占位模块；真正的依赖由用例注入。
      "wasp/server": fileURLToPath(
        new URL("./src/test/wasp-server.stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
