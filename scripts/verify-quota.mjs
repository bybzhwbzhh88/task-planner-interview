#!/usr/bin/env node
/**
 * 额度处理验证脚本 —— 覆盖 SPEC.md 中的验收案例 A1–A5。
 *
 * 它验证的是仓库里的真实代码：用 esbuild 把 `src/demo-ai-app/planGeneration.ts`
 * 和 `src/demo-ai-app/mockAi.ts`（连同它们的无扩展名相对导入）打包成 Node 可
 * 直接加载的 ESM，再动态 import。脚本里没有任何复制粘贴的业务逻辑。
 *
 * 运行前提：
 *   1. 一个专用的 PostgreSQL 数据库，并把 `DATABASE_URL` 指向它；
 *   2. 已按 `schema.prisma` 建表：`npx prisma db push --schema schema.prisma`；
 *   3. 一个安装了 `@prisma/client`、`prisma`、`esbuild` 的工具目录，通过
 *      `PRISMA_CLIENT_DIR` 指定（默认为当前目录）。之所以要外部工具目录，
 *      是因为 Windows 上无法安装 Wasp CLI，项目自身的 `npm install` 走不通
 *      （`@wasp.sh/spec` 依赖 `.wasp/` 生成物）。
 *
 * 运行示例（bash / WSL / macOS / Linux）：
 *   export DATABASE_URL="postgresql://postgres@localhost:5433/quota_verify"
 *   export PRISMA_CLIENT_DIR="/path/to/tools"
 *   node scripts/verify-quota.mjs
 *
 * 退出码：全部通过为 0，任一失败为 1。
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const toolsDir = process.env.PRISMA_CLIENT_DIR ?? process.cwd();
const requireFromTools = createRequire(path.join(toolsDir, "package.json"));

if (!process.env.DATABASE_URL) {
  console.error("[verify-quota] 缺少 DATABASE_URL 环境变量。");
  process.exit(1);
}

const { PrismaClient } = requireFromTools("@prisma/client");
const prisma = new PrismaClient();

const tmpDir = mkdtempSync(path.join(tmpdir(), "quota-verify-"));
const createdUserIds = [];
const results = [];

async function loadRealModules() {
  const esbuild = requireFromTools("esbuild");
  const bundles = [
    ["planGeneration.ts", "planGeneration.mjs"],
    ["mockAi.ts", "mockAi.mjs"],
  ];
  for (const [source, outfile] of bundles) {
    await esbuild.build({
      entryPoints: [path.join(repoRoot, "src", "demo-ai-app", source)],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: path.join(tmpDir, outfile),
      logLevel: "silent",
    });
  }
  const planGeneration = await import(
    pathToFileURL(path.join(tmpDir, "planGeneration.mjs")).href
  );
  const mockAi = await import(
    pathToFileURL(path.join(tmpDir, "mockAi.mjs")).href
  );
  return { planGeneration, mockAi };
}

function countingProvider(realProvider) {
  const state = { calls: 0 };
  return {
    state,
    provider: async (tasks, hours) => {
      state.calls += 1;
      return realProvider(tasks, hours);
    },
  };
}

async function createUserWithTasks(credits, taskDescriptions) {
  const user = await prisma.user.create({ data: { credits } });
  createdUserIds.push(user.id);
  const tasks = [];
  for (const description of taskDescriptions) {
    tasks.push(
      await prisma.task.create({
        data: { description, userId: user.id },
      }),
    );
  }
  return { user, tasks };
}

function record(name, checks) {
  const failed = checks.filter((check) => !check.ok);
  results.push({
    name,
    ok: failed.length === 0,
    checks,
  });
}

// A0 基线对照：按 114aeb2 里 generatePlan 的额度行为复刻一份（先调用模型、
// 用请求开始时的快照判断、无条件 decrement），用同样的压测证明旧逻辑确实
// 会透支——这是「修复有效」的反向证据。注意：这一段是复刻，不是线上代码。
// PASS 的含义是「基线的四个问题全部被复现」。
async function baselineGenerate({ db, userId, snapshotCredits, provider, tasks, hours }) {
  // 1) 先调用模型（基线在判断额度之前就发起了调用）
  await provider(tasks, hours);
  // 2) 用快照判断（基线读的是 context.user.credits，并发下是旧值）
  if (snapshotCredits <= 0) {
    const error = new Error("User is out of credits");
    error.name = "BaselineOutOfCredits";
    throw error;
  }
  // 3) 无条件扣减（基线的 decrement 没有 credits >= 1 条件）
  await db.user.update({
    where: { id: userId },
    data: { credits: { decrement: 1 } },
  });
}

async function scenarioA0(realProvider) {
  const checks = [];

  // 基线问题 1：额度为 0 时仍发起了模型调用
  {
    const { user, tasks } = await createUserWithTasks(0, ["基线任务"]);
    const counter = countingProvider(realProvider);
    try {
      await baselineGenerate({
        db: prisma,
        userId: user.id,
        snapshotCredits: 0,
        provider: counter.provider,
        tasks,
        hours: 4,
      });
    } catch {
      // 基线此时才抛 402
    }
    checks.push({
      ok: counter.state.calls > 0,
      detail: `基线额度为 0 时模型仍被调用 ${counter.state.calls} 次（复现 P1：调用发生在判断之前）`,
    });
    await prisma.task.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    createdUserIds.pop();
  }

  // 基线问题 2：并发下用旧快照判断 + 无条件扣减 → 透支
  {
    const { user, tasks } = await createUserWithTasks(1, ["基线并发任务"]);
    const counter = countingProvider(realProvider);
    await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        baselineGenerate({
          db: prisma,
          userId: user.id,
          snapshotCredits: 1,
          provider: counter.provider,
          tasks,
          hours: 4,
        }),
      ),
    );
    const after = await prisma.user.findUnique({
      where: { id: user.id },
      select: { credits: true },
    });
    checks.push({
      ok: after.credits < 0,
      detail: `基线并发 10 请求后 credits = ${after.credits}（复现 P2/P3：额度透支）`,
    });
    checks.push({
      ok: counter.state.calls === 10,
      detail: `基线并发时模型被调用 ${counter.state.calls} 次，额度只有 1（复现超发调用）`,
    });
    await prisma.task.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    createdUserIds.pop();
  }

  results.push({
    name: "A0 基线对照（PASS = 旧逻辑的问题被复现）",
    ok: checks.every((c) => c.ok),
    checks,
  });
}

// A1 成功生成：扣 1 个额度，落库 1 条 PlanResult，模型调用 1 次
async function scenarioA1(generatePlanForUser, realProvider) {
  const { user, tasks } = await createUserWithTasks(3, ["写周报", "准备复盘"]);
  const counter = countingProvider(realProvider);

  const outcome = await generatePlanForUser({
    db: prisma,
    userId: user.id,
    tasks: tasks.map((t) => ({ description: t.description, time: t.time })),
    hours: 4,
    provider: counter.provider,
  });

  const after = await prisma.user.findUnique({
    where: { id: user.id },
    select: { credits: true },
  });
  const planResults = await prisma.planResult.count({
    where: { userId: user.id },
  });

  record("A1 成功生成", [
    { ok: outcome.schedule.tasks.length === 2, detail: `日程包含 ${outcome.schedule.tasks.length} 个任务（预期 2）` },
    { ok: outcome.creditsRemaining === 2, detail: `返回剩余额度 ${outcome.creditsRemaining}（预期 2）` },
    { ok: after.credits === 2, detail: `数据库额度 ${after.credits}（预期 2）` },
    { ok: planResults === 1, detail: `PlanResult ${planResults} 条（预期 1）` },
    { ok: counter.state.calls === 1, detail: `模型调用 ${counter.state.calls} 次（预期 1）` },
  ]);
}

// A2 额度不足：不发起模型调用，额度不变，不落库
async function scenarioA2(generatePlanForUser, realProvider) {
  const { user, tasks } = await createUserWithTasks(0, ["整理 inbox"]);
  const counter = countingProvider(realProvider);

  let error = null;
  try {
    await generatePlanForUser({
      db: prisma,
      userId: user.id,
      tasks: tasks.map((t) => ({ description: t.description, time: t.time })),
      hours: 4,
      provider: counter.provider,
    });
  } catch (e) {
    error = e;
  }

  const after = await prisma.user.findUnique({
    where: { id: user.id },
    select: { credits: true },
  });
  const planResults = await prisma.planResult.count({
    where: { userId: user.id },
  });

  record("A2 额度不足", [
    { ok: error?.name === "QuotaExhaustedError", detail: `抛出 ${error?.name ?? "无"}（预期 QuotaExhaustedError）` },
    { ok: counter.state.calls === 0, detail: `模型调用 ${counter.state.calls} 次（预期 0：额度不足不得发起调用）` },
    { ok: after.credits === 0, detail: `数据库额度 ${after.credits}（预期 0）` },
    { ok: planResults === 0, detail: `PlanResult ${planResults} 条（预期 0）` },
  ]);
}

// A3 模型失败：先占位再退还，净变化 0，不落库
async function scenarioA3(generatePlanForUser, realProvider) {
  const { user, tasks } = await createUserWithTasks(2, ["[fail] 有问题的任务"]);
  const counter = countingProvider(realProvider);

  let error = null;
  try {
    await generatePlanForUser({
      db: prisma,
      userId: user.id,
      tasks: tasks.map((t) => ({ description: t.description, time: t.time })),
      hours: 4,
      provider: counter.provider,
    });
  } catch (e) {
    error = e;
  }

  const after = await prisma.user.findUnique({
    where: { id: user.id },
    select: { credits: true },
  });
  const planResults = await prisma.planResult.count({
    where: { userId: user.id },
  });

  record("A3 模型失败", [
    { ok: error?.name === "ProviderError", detail: `抛出 ${error?.name ?? "无"}（预期 ProviderError）` },
    { ok: counter.state.calls === 1, detail: `模型调用 ${counter.state.calls} 次（预期 1）` },
    { ok: after.credits === 2, detail: `数据库额度 ${after.credits}（预期 2：已退还）` },
    { ok: planResults === 0, detail: `PlanResult ${planResults} 条（预期 0）` },
  ]);
}

// A4/A5 并发：同一账号同时发起 N 个请求，只有 credits 个能成功
async function concurrencyScenario(
  name,
  initialCredits,
  concurrency,
  generatePlanForUser,
  realProvider,
) {
  const { user, tasks } = await createUserWithTasks(initialCredits, [
    "并发任务 A",
    "并发任务 B",
  ]);
  const counter = countingProvider(realProvider);
  const taskInputs = tasks.map((t) => ({
    description: t.description,
    time: t.time,
  }));

  const settled = await Promise.allSettled(
    Array.from({ length: concurrency }, () =>
      generatePlanForUser({
        db: prisma,
        userId: user.id,
        tasks: taskInputs,
        hours: 4,
        provider: counter.provider,
      }),
    ),
  );

  const successes = settled.filter((s) => s.status === "fulfilled").length;
  const quotaErrors = settled.filter(
    (s) => s.status === "rejected" && s.reason?.name === "QuotaExhaustedError",
  ).length;
  const otherErrors = settled.filter(
    (s) =>
      s.status === "rejected" && s.reason?.name !== "QuotaExhaustedError",
  ).length;

  const after = await prisma.user.findUnique({
    where: { id: user.id },
    select: { credits: true },
  });
  const planResults = await prisma.planResult.count({
    where: { userId: user.id },
  });

  record(name, [
    { ok: successes === initialCredits, detail: `成功 ${successes} 次（预期 ${initialCredits}）` },
    { ok: quotaErrors === concurrency - initialCredits, detail: `额度不足 ${quotaErrors} 次（预期 ${concurrency - initialCredits}）` },
    { ok: otherErrors === 0, detail: `其它错误 ${otherErrors} 次（预期 0）` },
    { ok: after.credits === 0, detail: `数据库额度 ${after.credits}（预期 0，不得为负）` },
    { ok: planResults === initialCredits, detail: `PlanResult ${planResults} 条（预期 ${initialCredits}）` },
    { ok: counter.state.calls === initialCredits, detail: `模型调用 ${counter.state.calls} 次（预期 ${initialCredits}：失败请求不发起调用）` },
  ]);
}

async function main() {
  const { planGeneration, mockAi } = await loadRealModules();
  const { generatePlanForUser } = planGeneration;
  const realProvider = mockAi.generateMockSchedule;

  await prisma.$connect();

  await scenarioA0(realProvider);
  await scenarioA1(generatePlanForUser, realProvider);
  await scenarioA2(generatePlanForUser, realProvider);
  await scenarioA3(generatePlanForUser, realProvider);
  await concurrencyScenario(
    "A4 并发不透支（1 额度 / 10 并发）",
    1,
    10,
    generatePlanForUser,
    realProvider,
  );
  await concurrencyScenario(
    "A5 并发多额度（3 额度 / 10 并发）",
    3,
    10,
    generatePlanForUser,
    realProvider,
  );

  console.log("\n========== 验证结果 ==========");
  for (const { name, ok, checks } of results) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    for (const check of checks) {
      console.log(`      ${check.ok ? "✓" : "✗"} ${check.detail}`);
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log("==============================");
  console.log(
    `${results.length - failed}/${results.length} 个场景通过，断言 ${results.reduce((n, r) => n + (r.ok ? r.checks.length : r.checks.length), 0)} 条。`,
  );

  return failed === 0 ? 0 : 1;
}

async function cleanup() {
  try {
    await prisma.planResult.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
    await prisma.task.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } finally {
    await prisma.$disconnect();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error("[verify-quota] 运行失败：", error);
  console.error(
    "[verify-quota] 请确认已执行 `npx prisma db push --schema schema.prisma`，并正确设置 DATABASE_URL / PRISMA_CLIENT_DIR。",
  );
} finally {
  await cleanup();
}
process.exit(exitCode);
