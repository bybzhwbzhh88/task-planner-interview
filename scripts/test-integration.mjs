import { spawnSync } from "node:child_process";

const value = process.env.TEST_DATABASE_URL;
if (!value) throw new Error("Set TEST_DATABASE_URL to a dedicated PostgreSQL database ending in _test.");
const url = new URL(value);
if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.pathname.endsWith("_test")) {
  throw new Error("Refusing to run: the PostgreSQL database name must end in _test.");
}

// Never reset a database. Apply the checked-in migrations, then clean up only
// the exact temporary user ids created by this test run.
for (const args of [
  ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "schema.prisma"],
  ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.integration.config.ts"],
]) {
  const child = spawnSync(process.execPath, args, {
    stdio: "inherit", env: { ...process.env, DATABASE_URL: value },
  });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status ?? 1);
}
