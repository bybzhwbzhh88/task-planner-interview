import { describe, expect, it } from "vitest";
import {
  PlanGenerationFailedError,
  QuotaExhaustedError,
  generatePlanForUser,
  type PlanDeps,
  type PlanStore,
} from "../src/demo-ai-app/planFlow";
import type { GeneratedSchedule } from "../src/demo-ai-app/schedule";

/**
 * 假存储：用内存模拟「条件更新」语义。
 * 它只能验证流程顺序与分支，不能证明数据库的并发语义——
 * 真正的并发证明在 `tests/planFlow.pg.test.ts`（真实 PostgreSQL）。
 */
function createFakeWorld(initialCredits: number) {
  const world = {
    credits: initialCredits,
    ledger: [] as { delta: number; reason: string; balanceAfter: number }[],
    planResults: [] as string[],
    providerCalls: 0,
  };

  const store = {
    user: {
      async updateMany(args: {
        where: { id: string; credits: { gte: number } };
        data: { credits: { decrement: number } };
      }) {
        if (world.credits < args.where.credits.gte) return { count: 0 };
        world.credits -= args.data.credits.decrement;
        return { count: 1 };
      },
      async findUniqueOrThrow() {
        return { credits: world.credits };
      },
      async update(args: { data: { credits: { increment: number } } }) {
        world.credits += args.data.credits.increment;
        return { credits: world.credits };
      },
    },
    creditLedgerEntry: {
      async create(args: {
        data: { delta: number; reason: string; balanceAfter: number };
      }) {
        // 只记录断言关心的字段，userId 由流程层补上、这里不参与比较。
        const entry = {
          delta: args.data.delta,
          reason: args.data.reason,
          balanceAfter: args.data.balanceAfter,
        };
        world.ledger.push(entry);
        return entry;
      },
    },
    task: {
      async findMany() {
        return [{ description: "写周报", time: "1" }];
      },
    },
    planResult: {
      async create(args: { data: { content: string } }) {
        world.planResults.push(args.data.content);
        return args.data;
      },
    },
  };

  return { world, store: store as unknown as PlanStore };
}

const schedule: GeneratedSchedule = {
  tasks: [{ name: "写周报", priority: "medium" }],
  taskItems: [{ description: "准备: 写周报", taskName: "写周报", time: 1 }],
};

type ProviderMode = "success" | "throw" | "null";

function createDeps(
  store: PlanStore,
  provider: ProviderMode,
  hooks: { onCall?: () => void } = {},
): PlanDeps {
  return {
    store,
    runTx: (work) => work(store),
    generateSchedule: async () => {
      hooks.onCall?.();
      if (provider === "throw") throw new Error("mock provider rejected");
      if (provider === "null") return null;
      return schedule;
    },
  };
}

describe("generatePlanForUser：额度规则", () => {
  it("AC-1 成功一次：扣 1、写账本、落库、返回余额", async () => {
    const { world, store } = createFakeWorld(3);
    const deps = createDeps(store, "success", {
      onCall: () => {
        world.providerCalls += 1;
      },
    });

    const outcome = await generatePlanForUser(deps, { userId: "u1", hours: 8 });

    expect(outcome.creditsRemaining).toBe(2);
    expect(outcome.schedule).toEqual(schedule);
    expect(world.credits).toBe(2);
    expect(world.providerCalls).toBe(1);
    expect(world.planResults).toHaveLength(1);
    expect(world.ledger).toEqual([
      { delta: -1, reason: "plan_reserved", balanceAfter: 2 },
    ]);
  });

  it("AC-2 额度为 0：抛 QuotaExhausted，且完全不调用模型、不写任何数据", async () => {
    const { world, store } = createFakeWorld(0);
    const deps = createDeps(store, "success", {
      onCall: () => {
        world.providerCalls += 1;
      },
    });

    await expect(
      generatePlanForUser(deps, { userId: "u1", hours: 8 }),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);

    expect(world.providerCalls).toBe(0);
    expect(world.planResults).toHaveLength(0);
    expect(world.ledger).toHaveLength(0);
    expect(world.credits).toBe(0);
  });

  it("AC-3 模型失败：退回额度，账本一扣一退，不落库", async () => {
    const { world, store } = createFakeWorld(2);
    const deps = createDeps(store, "throw", {
      onCall: () => {
        world.providerCalls += 1;
      },
    });

    await expect(
      generatePlanForUser(deps, { userId: "u1", hours: 8 }),
    ).rejects.toMatchObject({
      name: "PlanGenerationFailedError",
      refundedBalance: 2,
    });

    expect(world.providerCalls).toBe(1);
    expect(world.credits).toBe(2);
    expect(world.planResults).toHaveLength(0);
    expect(world.ledger).toEqual([
      { delta: -1, reason: "plan_reserved", balanceAfter: 1 },
      { delta: 1, reason: "plan_refunded", balanceAfter: 2 },
    ]);
  });

  it("落库失败：同样退回额度", async () => {
    const { world, store } = createFakeWorld(1);
    const failingStore: PlanStore = {
      ...store,
      planResult: {
        async create() {
          throw new Error("insert failed");
        },
      },
    };

    await expect(
      generatePlanForUser(createDeps(failingStore, "success"), {
        userId: "u1",
        hours: 8,
      }),
    ).rejects.toBeInstanceOf(PlanGenerationFailedError);

    expect(world.credits).toBe(1);
    expect(world.ledger.map((entry) => entry.delta)).toEqual([-1, 1]);
  });

  it("模型返回 null 视为失败，额度退回", async () => {
    const { world, store } = createFakeWorld(1);

    await expect(
      generatePlanForUser(createDeps(store, "null"), { userId: "u1", hours: 8 }),
    ).rejects.toBeInstanceOf(PlanGenerationFailedError);

    expect(world.credits).toBe(1);
    expect(world.planResults).toHaveLength(0);
  });

  it("AC-5 连续生成：逐次递减，额度用尽后拒绝且不再调用模型", async () => {
    const { world, store } = createFakeWorld(2);
    const deps = createDeps(store, "success", {
      onCall: () => {
        world.providerCalls += 1;
      },
    });

    const first = await generatePlanForUser(deps, { userId: "u1", hours: 8 });
    const second = await generatePlanForUser(deps, { userId: "u1", hours: 8 });
    await expect(
      generatePlanForUser(deps, { userId: "u1", hours: 8 }),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);

    expect([first.creditsRemaining, second.creditsRemaining]).toEqual([1, 0]);
    expect(world.providerCalls).toBe(2);
    expect(world.credits).toBe(0);
  });

  it("并发调用只依赖存储的条件更新：假存储下 10 并发只成功 3 次", async () => {
    const { world, store } = createFakeWorld(3);
    const deps = createDeps(store, "success", {
      onCall: () => {
        world.providerCalls += 1;
      },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        generatePlanForUser(deps, { userId: "u1", hours: 8 }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(3);
    expect(world.credits).toBe(0);
    expect(world.providerCalls).toBe(3);
  });
});
