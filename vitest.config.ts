import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["tests/unit/**/*.test.ts"] } },
      { test: { name: "integration", include: ["tests/integration/**/*.test.ts"], fileParallelism: false, testTimeout: 15000, hookTimeout: 30000 } },
    ],
  },
});
