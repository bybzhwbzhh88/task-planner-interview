import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  QuotaExhaustedError,
  generatePlanForUser,
  type PlanDeps,
  type PlanStore,
} from "../src/demo-ai-app/planFlow";
import type { QuotaStore, TxRunner } from "../src/demo-ai-app/quota";
import type { GeneratedSchedule } from "../src/demo-ai-app/schedule";

/**
 * 真实 PostgreSQL 上的并发验证。
 *
 * 运行前提：
 *   1. 有可用数据库，且已执行 `wasp db migrate-dev`（或 `npx prisma migrate deploy`）；
 *   2. 设置 TEST_DATABASE_URL，例如
 *      TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/planner_test npx vitest run tests/planFlow.pg.test.ts
 *
 * 未设置 TEST_DATABASE_URL 时整组跳过，不影响 `npm test`。
 * 测试自身创建并清理数据（按 userId 精确删除）。
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const CONCURRENCY_WAIT_MS = 50;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSchedule(taskNames: string[]): GeneratedSchedule {
  return {
    tasks: taskNames.map((name) => ({ name, priority: "medium" as const })),
    taskItems: taskNames.map((name) => ({
      description: `准备: ${name}`,
      taskName: name,
      time: 1,
    })),
  };
}

describeWithDb("额度预占与退回（真实 PostgreSQL）", () => {
  let prisma: any;
  const createdUserIds: string[] = [];
  let providerCalls = 0;

  beforeAll(async () => {
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL } },
    });
    await prisma.$connect();
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.creditLedgerEntry.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
    await prisma.planResult.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
    await prisma.task.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  /** 建一个测试账号，`credits` 直接落库（模拟 db studio 手工改余额）。 */
  async function createUser(credits: number, taskDescriptions: string[]) {
    const user = await prisma.user.create({
      data: {
        credits,
        tasks: { create: taskDescriptions.map((description) => ({ description })) },
      },
    });
    createdUserIds.push(user.id);
    return user.id as string;
  }

  function createDeps(): PlanDeps {
    const store = prisma as unknown as PlanStore;
    const runTx: TxRunner = (work) =>
      prisma.$transaction((tx: unknown) => work(tx as QuotaStore));
    return {
      store,
      runTx,
      generateSchedule: async (tasks, hours) => {
        providerCalls += 1;
        // 让出事件循环，保证并发请求真正重叠
        await sleep(CONCURRENCY_WAIT_MS);
        if (tasks.some((task) => task.description.includes("[fail]"))) {
          throw new Error("Mock provider explicitly rejected the request");
        }
        return makeSchedule(tasks.map((task) => task.description));
      },
    };
  }

  async function readCredits(userId: string) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { credits: true },
    });
    return user.credits as number;
  }

  async function readLedger(userId: string) {
    return prisma.creditLedgerEntry.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { delta: true, reason: true, balanceAfter: true },
    });
  }

  function sumDelta(ledger: { delta: number }[]) {
    return ledger.reduce((total, entry) => total + entry.delta, 0);
  }

  it("AC-1 成功一次：余额 -1、落库 1 条、账本 -1、模型调用 1 次", async () => {
    providerCalls = 0;
    const userId = await createUser(3, ["写周报"]);
    const outcome = await generatePlanForUser(createDeps(), { userId, hours: 8 });

    expect(outcome.creditsRemaining).toBe(2);
    expect(await readCredits(userId)).toBe(2);
    expect(await prisma.planResult.count({ where: { userId } })).toBe(1);
    expect(sumDelta(await readLedger(userId))).toBe(-1);
  });

  it("AC-2 额度为 0：402 语义，模型调用 0 次，无任何写入", async () => {
    providerCalls = 0;
    const userId = await createUser(0, ["写周报"]);

    await expect(
      generatePlanForUser(createDeps(), { userId, hours: 8 }),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);

    expect(providerCalls).toBe(0);
    expect(await readCredits(userId)).toBe(0);
    expect(await prisma.planResult.count({ where: { userId } })).toBe(0);
    expect(await readLedger(userId)).toHaveLength(0);
  });

  it("AC-3 模型失败：余额不变，账本 -1/+1 互相抵消，不落库", async () => {
    const userId = await createUser(2, ["写周报", "[fail] 做汇报"]);

    await expect(
      generatePlanForUser(createDeps(), { userId, hours: 8 }),
    ).rejects.toMatchObject({ name: "PlanGenerationFailedError" });

    expect(await readCredits(userId)).toBe(2);
    expect(await prisma.planResult.count({ where: { userId } })).toBe(0);
    expect(sumDelta(await readLedger(userId))).toBe(0);
  });

  it("AC-4 并发 10 个请求（余额 3）：只有 3 个成功，余额不为负", async () => {
    providerCalls = 0;
    const userId = await createUser(3, ["写周报"]);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        generatePlanForUser(createDeps(), { userId, hours: 8 }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(7);
    expect(rejected.every((r) => r.reason instanceof QuotaExhaustedError)).toBe(
      true,
    );
    expect(providerCalls).toBe(3);
    expect(await readCredits(userId)).toBe(0);
    expect(await prisma.planResult.count({ where: { userId } })).toBe(3);
    expect(sumDelta(await readLedger(userId))).toBe(-3);
  });

  it("AC-5 顺序耗尽：余额 1 时第 1 次成功，之后拒绝，模型只调用 1 次", async () => {
    providerCalls = 0;
    const userId = await createUser(1, ["写周报"]);
    const deps = createDeps();

    await generatePlanForUser(deps, { userId, hours: 8 });
    await expect(
      generatePlanForUser(deps, { userId, hours: 8 }),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
    await expect(
      generatePlanForUser(deps, { userId, hours: 8 }),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);

    expect(providerCalls).toBe(1);
    expect(await readCredits(userId)).toBe(0);
  });

  it("并发 + 全部失败：余额归还到初始值，账本净额 0，不落库", async () => {
    providerCalls = 0;
    const userId = await createUser(3, ["[fail] 做汇报"]);

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        generatePlanForUser(createDeps(), { userId, hours: 8 }),
      ),
    );

    const reasons = results.map((r) => (r.status === "rejected" ? r.reason.name : "fulfilled"));
    const failed = reasons.filter((name) => name === "PlanGenerationFailedError");
    const exhausted = reasons.filter((name) => name === "QuotaExhaustedError");

    // 3 个抢到额度的请求因模型失败而退回，其余 3 个当场被拒。
    expect(failed.length + exhausted.length).toBe(6);
    expect(await readCredits(userId)).toBe(3);
    expect(sumDelta(await readLedger(userId))).toBe(0);
    expect(await prisma.planResult.count({ where: { userId } })).toBe(0);
    expect(providerCalls).toBe(failed.length);
  });
});
