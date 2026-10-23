import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Vitest setup: point Prisma at the disposable test database before any test
// module instantiates a PrismaClient. The URL comes from TEST_DATABASE_URL or
// the .env.test file written by scripts/test-db-setup.sh (SPEC.md §7), so
// tests never touch the development database.

function readTestDatabaseUrl(): string | undefined {
  if (process.env.TEST_DATABASE_URL) {
    return process.env.TEST_DATABASE_URL;
  }
  const envTestPath = resolve(process.cwd(), ".env.test");
  if (existsSync(envTestPath)) {
    const line = readFileSync(envTestPath, "utf8")
      .split("\n")
      .find((l) => l.startsWith("TEST_DATABASE_URL="));
    if (line) {
      return line.slice("TEST_DATABASE_URL=".length).trim();
    }
  }
  return undefined;
}

const testDatabaseUrl = readTestDatabaseUrl();
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is not set. Run `npm run test:setup` (scripts/test-db-setup.sh) first.",
  );
}
process.env.DATABASE_URL = testDatabaseUrl;
