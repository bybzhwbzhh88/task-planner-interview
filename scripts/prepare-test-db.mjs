import { PrismaClient } from "@prisma/client";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

if (process.argv.includes("--help")) {
  console.log("node scripts/prepare-test-db.mjs --name task_planner_quota_test\nReads .env.server, creates only a database ending _quota_test, applies migrations and writes ignored .env.quota-test (0600). Requires CREATEDB permission.");
  process.exit(0);
}
const name = process.argv[process.argv.indexOf("--name") + 1];
if (!process.argv.includes("--name") || !/^[a-z][a-z0-9_]*_quota_test$/.test(name ?? "")) {
  throw new Error("Pass an explicit --name ending _quota_test");
}
process.loadEnvFile(".env.server");
const source = process.env.DATABASE_URL;
if (!source) throw new Error("DATABASE_URL is missing");
const target = new URL(source);
target.pathname = "/" + name;
const adminUrl = new URL(source);
adminUrl.pathname = "/postgres";
const admin = new PrismaClient({ datasources: { db: { url: adminUrl.href } } });
try {
  const exists = await admin.$queryRaw`SELECT 1 FROM pg_database WHERE datname = ${name}`;
  if (!exists.length) await admin.$executeRawUnsafe('CREATE DATABASE "' + name + '"');
} finally {
  await admin.$disconnect();
}
const result = spawnSync("npx", ["prisma", "migrate", "deploy", "--schema", ".wasp/out/db/schema.prisma"], {
  env: { ...process.env, DATABASE_URL: target.href }, encoding: "utf8",
});
process.stdout.write(result.stdout ?? "");
if (result.status !== 0) {
  // Do not print configuration values or a potentially credential-bearing CLI error.
  throw new Error("Test migration failed; inspect database state (exit " + result.status + ")");
}
writeFileSync(".env.quota-test", "TEST_DATABASE_URL=" + target.href + "\n", { mode: 0o600 });
console.log("Ready: isolated " + name + "; configuration saved to ignored .env.quota-test");
