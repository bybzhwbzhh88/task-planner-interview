import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Check before Prisma's generated module can load its own default .env file.
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required: run these tests against PostgreSQL after wasp db migrate-dev.");
}

export default defineConfig({
  resolve: {
    alias: [{
      find: /^wasp\/server$/,
      replacement: fileURLToPath(new URL("./support/wasp-server.ts", import.meta.url)),
    }],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 10_000,
  },
});
