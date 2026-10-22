import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const testUrl = process.env.TEST_DATABASE_URL;
let database;
try {
  const url = new URL(testUrl ?? "");
  database = decodeURIComponent(url.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !database.endsWith("_test")) {
    throw new Error();
  }
} catch {
  console.error("请设置 TEST_DATABASE_URL，指向名称以 _test 结尾的独立 PostgreSQL 数据库。");
  process.exit(1);
}

const schema = ".wasp/out/db/schema.prisma";
if (!existsSync(new URL(`../${schema}`, import.meta.url))) {
  console.error("缺少 Wasp 生成文件，请先运行 wasp compile。");
  process.exit(1);
}

const env = { ...process.env, DATABASE_URL: testUrl, NODE_ENV: "development" };
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`额度验收数据库：${database}`);
run(["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", schema]);
run(["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.config.ts", ...process.argv.slice(2)]);
