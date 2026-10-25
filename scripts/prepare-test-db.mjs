import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveTestDatabaseUrl } from "./testDatabase.mjs";

try {
  const url = resolveTestDatabaseUrl();
  const root = fileURLToPath(new URL("../", import.meta.url));
  const prisma = fileURLToPath(new URL("../node_modules/prisma/build/index.js", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [prisma, "migrate", "deploy", "--schema", "schema.prisma"],
    { cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" },
  );

  let output = `${result.stdout || ""}${result.stderr || ""}`;
  // 输出里绝不能留下测试库口令或完整连接串。
  output = output.replace(/postgres(?:ql)?:\/\/[^\s"']+/giu, "[database URL redacted]");
  try {
    const password = decodeURIComponent(new URL(url).password);
    if (password) output = output.replaceAll(password, "[redacted]");
  } catch {
    // 口令已由整串替换覆盖。
  }
  process.stdout.write(output);
  if (result.error) {
    process.stderr.write("无法启动已安装的 Prisma 迁移命令，请先执行 wasp install。\n");
  }
  process.exitCode = result.status ?? 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "测试库准备失败"}\n`);
  process.exitCode = 1;
}
