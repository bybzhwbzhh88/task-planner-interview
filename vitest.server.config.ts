import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    reporters: ["default", "json"],
    outputFile: { json: "test-results/quota/vitest.json" },
  },
});
