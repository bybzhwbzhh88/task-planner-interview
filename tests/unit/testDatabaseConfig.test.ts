import { afterEach, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
const appUrl = "postgresql://app:synthetic_password@127.0.0.1:55439/application_quota_test";
const testUrl = "postgresql://tester:synthetic_password@127.0.0.1:55439/independent_quota_test";

function runGuard({ file, environmentUrl, target = testUrl }: { file?: string; environmentUrl?: string; target?: string | null }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quota-db-guard-"))); roots.push(root);
  mkdirSync(join(root, "scripts")); mkdirSync(join(root, "node_modules/prisma/build"), { recursive: true });
  copyFileSync(new URL("../../scripts/test-db.mjs", import.meta.url), join(root, "scripts/test-db.mjs"));
  if (file !== undefined) writeFileSync(join(root, ".env.server"), file);
  // Observe calls at the Prisma boundary without running Prisma or connecting to any database.
  const marker = join(root, "prisma-calls.jsonl");
  writeFileSync(join(root, "node_modules/prisma/build/index.js"), `require('node:fs').appendFileSync(process.env.QUOTA_GUARD_MARKER, JSON.stringify({ args: process.argv.slice(2), database: process.env.DATABASE_URL, privateSetting: process.env.QUOTA_GUARD_PRIVATE }) + '\\n');`);
  const env = { ...process.env, QUOTA_GUARD_MARKER: marker };
  delete env.DATABASE_URL; delete env.QUOTA_TEST_DATABASE_URL; delete env.QUOTA_GUARD_PRIVATE;
  if (environmentUrl !== undefined) env.DATABASE_URL = environmentUrl;
  if (target !== null) env.QUOTA_TEST_DATABASE_URL = target;
  const result = spawnSync(process.execPath, [join(root, "scripts/test-db.mjs")], { cwd: root, env, encoding: "utf8" });
  return { ...result, calledPrisma: existsSync(marker), calls: existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [] };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each([
  `DATABASE_URL=${appUrl}\n`,
  `export DATABASE_URL="${appUrl}" # application only\n`,
  `DATABASE_URL='postgresql://different@localhost:55439/application_quota_test?schema=public'\n`,
])("应用地址仅在.env.server时，必须在调用Prisma前拒绝同库 %s", file => {
  const result = runGuard({ file, target: appUrl });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Test database must differ");
  expect(result.calledPrisma).toBe(false);
});
it("shell地址不同也不能绕过.env.server中记录的应用库", () => {
  const result = runGuard({ file: `DATABASE_URL=${appUrl}\n`, environmentUrl: "postgresql://localhost:55439/another_app", target: appUrl });
  expect(result.status).not.toBe(0); expect(result.calledPrisma).toBe(false);
});
it("没有.env.server时仍拒绝与shell应用地址相同的库", () => {
  const result = runGuard({ environmentUrl: appUrl, target: appUrl });
  expect(result.status).not.toBe(0); expect(result.calledPrisma).toBe(false);
});
it("真正独立的测试库可运行，应用配置不会覆盖目标或进入子进程", () => {
  const result = runGuard({ file: `DATABASE_URL=${appUrl}\nQUOTA_GUARD_PRIVATE=must_not_export\n` });
  expect(result.status).toBe(0);
  expect(result.calls).toEqual([
    { args: ["generate", "--schema", ".wasp/out/db/schema.prisma"], database: testUrl },
    { args: ["migrate", "deploy", "--schema", ".wasp/out/db/schema.prisma"], database: testUrl },
  ]);
});
it("不能把.env.server地址回退成未显式指定的测试库", () => {
  const result = runGuard({ file: `DATABASE_URL=${appUrl}\n`, target: null });
  expect(result.status).not.toBe(0); expect(result.calledPrisma).toBe(false);
});
it("应用配置损坏时停止，且不把配置中的凭据写入错误输出", () => {
  const result = runGuard({ file: "DATABASE_URL='invalid://synthetic_password@'\n" });
  expect(result.status).not.toBe(0); expect(result.calledPrisma).toBe(false);
  expect(result.stderr).not.toContain("synthetic_password");
});
