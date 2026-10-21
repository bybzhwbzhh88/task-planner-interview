/**
 * 额度处理验证脚本（可重复执行）。
 *
 * 覆盖 ACCEPTANCE.md 的 AC1/AC2/AC3+AC5/AC4 四类场景，直接对真实
 * PostgreSQL 验证 src/demo-ai-app/credits.ts 的 SQL 语义：
 *   reserveCredit = updateMany({ where: { id, credits: { gt: 0 } }, data: { credits: { decrement: 1 } } })
 *   refundCredit  = update({ where: { id }, data: { credits: { increment: 1 } } })
 *
 * 运行方式（仓库根目录）：
 *   npm install --workspaces=false
 *   npx prisma generate
 *   node scripts/verify-credits.mjs
 *
 * 未设置 DATABASE_URL 时，脚本会用 embedded-postgres（devDependencies）
 * 在 .verify-pg 目录启动一个临时 PostgreSQL 并自动建表，结束后关闭。
 * 已设置 DATABASE_URL 时直接使用该库（要求可写，会建表并清理测试数据）。
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

// ---------- 数据库准备 ----------
let embedded = null;
if (!process.env.DATABASE_URL) {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  rmSync(".verify-pg", { recursive: true, force: true });
  embedded = new EmbeddedPostgres({
    databaseDir: ".verify-pg",
    user: "postgres",
    password: "postgres",
    port: 55432,
    persistent: false,
    // 中文 Windows 的默认 locale 没有 PG text search 配置，强制 C locale
    initdbFlags: ["--locale=C", "--encoding=UTF8"],
  });
  await embedded.initialise();
  await embedded.start();
  await embedded.createDatabase("taskplanner");
  process.env.DATABASE_URL =
    "postgresql://postgres:postgres@127.0.0.1:55432/taskplanner";
  console.log("已启动临时 PostgreSQL（embedded，端口 55432）");
}

const repoRoot = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
execSync("npx prisma db push --skip-generate", {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

const prisma = new PrismaClient();

// 与 credits.ts 完全一致的 SQL 语义（镜像实现，避免引入 TS 构建链）
const reserveCredit = (userId) =>
  prisma.user.updateMany({
    where: { id: userId, credits: { gt: 0 } },
    data: { credits: { decrement: 1 } },
  });
const refundCredit = (userId) =>
  prisma.user.update({
    where: { id: userId },
    data: { credits: { increment: 1 } },
  });
const getCredits = async (userId) =>
  (await prisma.user.findUnique({ where: { id: userId } }))?.credits ?? 0;

async function newTestUser(credits) {
  return prisma.user.create({ data: { id: `verify-${randomUUID()}`, credits } });
}
async function dropTestUser(userId) {
  await prisma.planResult.deleteMany({ where: { userId } });
  await prisma.task.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

try {
  // ---------- AC1 成功生成消耗额度 ----------
  {
    const user = await newTestUser(3);
    const reserved = (await reserveCredit(user.id)).count;
    const after = await getCredits(user.id);
    const plan = await prisma.planResult.create({
      data: { userId: user.id, content: JSON.stringify({ ok: true }) },
    });
    record(
      "AC1 成功路径：预扣 1 次成功、余额 3→2、PlanResult 可写入",
      reserved === 1 && after === 2 && !!plan.id,
      `count=${reserved}, credits=${after}`
    );
    await dropTestUser(user.id);
  }

  // ---------- AC2 额度不足不发起调用 ----------
  {
    const user = await newTestUser(0);
    const reserved = (await reserveCredit(user.id)).count;
    const after = await getCredits(user.id);
    // 预扣返回 0 即调用方应直接 402，不会走到 generateMockSchedule（日志断言在 UI 验证中）
    record(
      "AC2 额度不足：预扣失败、余额保持 0 不为负",
      reserved === 0 && after === 0,
      `count=${reserved}, credits=${after}`
    );
    await dropTestUser(user.id);
  }

  // ---------- AC3 + AC5 失败退回、余额一致 ----------
  {
    const user = await newTestUser(3);
    for (let i = 0; i < 2; i++) {
      const reserved = (await reserveCredit(user.id)).count;
      if (reserved === 1) {
        // 模拟 mock-ai.failed：预扣成功后调用失败 → 退回
        await refundCredit(user.id);
      }
    }
    const after = await getCredits(user.id);
    record(
      "AC3/AC5 失败退回：两轮预扣+退回后余额仍为 3",
      after === 3,
      `credits=${after}`
    );
    await dropTestUser(user.id);
  }

  // ---------- AC4 并发不透支 ----------
  {
    const user = await newTestUser(1);
    const outcomes = await Promise.all(
      [0, 1, 2].map(() => reserveCredit(user.id))
    );
    const successCount = outcomes.filter((r) => r.count === 1).length;
    const after = await getCredits(user.id);
    record(
      "AC4 并发：3 个并发预扣只有 1 个成功、余额 1→0 不为负",
      successCount === 1 && after === 0,
      `success=${successCount}, credits=${after}`
    );
    await dropTestUser(user.id);
  }
} finally {
  await prisma.$disconnect();
  if (embedded) {
    await embedded.stop();
    console.log("临时 PostgreSQL 已关闭");
  }
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} 通过` +
    (failed.length ? "，存在失败项" : "，全部通过")
);
process.exit(failed.length ? 1 : 0);
