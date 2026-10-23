import { spawnSync } from "node:child_process";

const url = process.env.QUOTA_TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) {
  throw new Error("QUOTA_TEST_DATABASE_URL must point to a dedicated database ending in _test");
}
// Use Wasp's generated schema, including auth models, for database initialization.
const migration = spawnSync("npm", ["run", "db-migrate-prod", "--workspace", "@wasp.sh/generated-server"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: url },
});
if (migration.status !== 0) process.exit(migration.status ?? 1);
const tests = spawnSync("npx", ["vitest", "run", "--config", "vitest.config.ts"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(tests.status ?? 1);
