import { defineConfig } from "vitest/config";

// Keep server-only tests independent of the Wasp/Vite browser plugin.
export default defineConfig({
  test: {
    include: ["tests/quota.test.ts"],
    environment: "node",
  },
});
