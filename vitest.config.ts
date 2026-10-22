import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "wasp/server": fileURLToPath(new URL("./tests/helpers/waspServer.ts", import.meta.url)),
      "wasp/client/operations": fileURLToPath(new URL("./tests/helpers/clientOperations.ts", import.meta.url)),
    },
  },
  test: { include: ["tests/unit/**/*.test.ts", "tests/ui/**/*.test.tsx"], testTimeout: 20_000 },
});
