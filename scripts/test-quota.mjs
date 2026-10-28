import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Only the generated, disposable database is migrated or dropped.
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
if (!process.env.DATABASE_URL && existsSync('.env.server')) {
  process.loadEnvFile('.env.server');
}
if (!process.env.DATABASE_URL) {
  throw new Error('请在 .env.server 或环境变量中设置 DATABASE_URL（需要 CREATEDB 权限）。');
}

const admin = new PrismaClient();
const database = `planner_quota_test_${randomBytes(6).toString('hex')}`;
const testUrl = new URL(process.env.DATABASE_URL);
testUrl.pathname = `/${database}`;
testUrl.searchParams.set('connection_limit', '8');
const env = {
  ...process.env,
  DATABASE_URL: testUrl.toString(),
  NODE_ENV: 'development',
  QUOTA_TEST_RUN: '1',
};
let created = false;
let exitCode = 1;

function run(args) {
  const result = spawnSync(process.execPath, args, { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

try {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
  created = true;
  console.log(`临时测试库：${database}（不改动原数据库中的数据）`);
  const migration = run([
    'node_modules/prisma/build/index.js', 'migrate', 'deploy',
    '--schema', '.wasp/out/db/schema.prisma',
  ]);
  if (migration === 0) {
    exitCode = run([
      'node_modules/vitest/vitest.mjs', 'run',
      '--config', 'vitest.quota.config.ts',
    ]);
  }
} finally {
  if (created) {
    await admin.$executeRawUnsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
    console.log('临时测试库已删除。');
  }
  await admin.$disconnect();
}
process.exitCode = exitCode;
