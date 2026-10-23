import { defineConfig } from "vitest/config";

// Server-side tests run through this config, separate from the client app's
// vite.config.ts. The disposable test database is prepared by
// scripts/test-db-setup.sh; test-env.setup.ts resolves and exports its URL
// before any test module runs (SPEC.md §7).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/demo-ai-app/test-env.setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
