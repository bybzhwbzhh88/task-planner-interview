import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

if (existsSync('.env.server')) loadEnvFile('.env.server');
if (!process.env.DATABASE_URL) throw new Error('Configure DATABASE_URL in .env.server first; see README.');
if (!existsSync('.wasp/out/db/schema.prisma')) throw new Error('Run wasp compile first.');
const dev = new URL(process.env.DATABASE_URL);
const admin = new PrismaClient({ datasources: { db: { url: dev.toString() } } });
const name = `task_planner_test_${randomUUID().replaceAll('-', '')}`;
let created = false;
const target = process.env.TEST_DATABASE_URL ? new URL(process.env.TEST_DATABASE_URL) : new URL(dev);
if (!process.env.TEST_DATABASE_URL) target.pathname = `/${name}`;
if (!target.pathname.startsWith('/task_planner_test_') || target.pathname === dev.pathname) {
  throw new Error('TEST_DATABASE_URL must use a dedicated task_planner_test_* database different from the development database.');
}
const env = { ...process.env, DATABASE_URL: target.toString(), TEST_DATABASE_URL: target.toString() };
let code = 1;
try {
  if (!process.env.TEST_DATABASE_URL) {
    try { await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`); created = true; }
    catch { throw new Error('Cannot create isolated database. Ask your local administrator to CREATE DATABASE task_planner_test_manual OWNER <dev_role>; then set TEST_DATABASE_URL. Credentials are not logged.'); }
  }
  const migration = spawnSync('node_modules/.bin/prisma', ['migrate', 'deploy', '--schema', '.wasp/out/db/schema.prisma'], { env, stdio: 'inherit' });
  if (migration.status !== 0) throw new Error('Test database migration failed.');
  const test = spawnSync('node_modules/.bin/vitest', ['run', '--config', 'vitest.quota.config.ts'], { env, stdio: 'inherit' });
  code = test.status ?? 1;
} finally {
  if (created) await admin.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.$disconnect();
}
process.exitCode = code;
