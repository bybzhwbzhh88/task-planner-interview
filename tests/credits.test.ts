import { describe, expect, it } from "vitest";
import {
  commitPlan,
  refundCredit,
  reserveCredit,
  type CreditStore,
} from "../src/demo-ai-app/credits";

/**
 * 假存储把 `updateMany` 当成一次原子的"判断 + 扣减"，与 Prisma 生成的
 * `UPDATE "User" SET credits = credits - 1 WHERE id = ? AND credits > 0` 语义对齐：
 * 调用内部不 await，JS 单线程下等价于单条 SQL 的原子性。
 *
 * 因此这组测试验证的是**调用方式**——预扣只有一条原子语句，没有"先读再写"的窗口。
 * 数据库层面的真实并发由 `scripts/verify-quota.mjs` 打真库验证（SPEC §8.1）。
 */
function createFakeStore(initialCredits: number, userId = "u1") {
  let credits = initialCredits;
  const store: CreditStore = {
    user: {
      updateMany: async ({ where }) => {
        if (where.id !== userId || credits <= 0) {
          return { count: 0 };
        }
        credits -= 1;
        return { count: 1 };
      },
      update: async () => {
        credits += 1;
        return { credits };
      },
      findUnique: async () => ({ credits }),
    },
    planResult: {
      create: async () => ({ id: "plan-1" }),
    },
  };

  return { store, read: () => credits };
}

describe("reserveCredit", () => {
  it("有余额时预扣成功并扣 1", async () => {
    const { store, read } = createFakeStore(3);

    await expect(reserveCredit(store, "u1")).resolves.toEqual({ ok: true });
    expect(read()).toBe(2);
  });

  it("余额为 0 时拒绝预扣，且不改变余额", async () => {
    const { store, read } = createFakeStore(0);

    await expect(reserveCredit(store, "u1")).resolves.toEqual({
      ok: false,
      reason: "insufficient_credits",
    });
    expect(read()).toBe(0);
  });

  it("并发发起 10 次预扣，只会成功 3 次，余额停在 0（AC-06 的逻辑层）", async () => {
    const { store, read } = createFakeStore(3);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserveCredit(store, "u1")),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(results.filter((result) => !result.ok)).toHaveLength(7);
    expect(read()).toBe(0);
  });

  it("用户不存在时视为额度不足", async () => {
    const { store } = createFakeStore(3);

    await expect(reserveCredit(store, "someone-else")).resolves.toEqual({
      ok: false,
      reason: "insufficient_credits",
    });
  });
});

describe("refundCredit", () => {
  it("退还后余额回到预扣前的值", async () => {
    const { store, read } = createFakeStore(3);

    await reserveCredit(store, "u1");
    await expect(refundCredit(store, "u1")).resolves.toEqual({ ok: true });
    expect(read()).toBe(3);
  });

  it("退还失败时返回 ok:false 而不是抛异常（不能让日志掩盖真实错误）", async () => {
    const { store } = createFakeStore(3);
    const brokenStore: CreditStore = {
      ...store,
      user: {
        ...store.user,
        update: async () => {
          throw new Error("db down");
        },
      },
    };

    await expect(refundCredit(brokenStore, "u1")).resolves.toEqual({
      ok: false,
    });
  });
});

describe("commitPlan", () => {
  it("写入产物并读回当前余额", async () => {
    const { store } = createFakeStore(3);

    await reserveCredit(store, "u1");
    await expect(commitPlan(store, "u1", "{}")).resolves.toEqual({
      planResultId: "plan-1",
      creditsRemaining: 2,
    });
  });

  it("写库失败时抛出，由调用方退还额度", async () => {
    const { store } = createFakeStore(3);
    const brokenStore: CreditStore = {
      ...store,
      planResult: {
        create: async () => {
          throw new Error("insert failed");
        },
      },
    };

    await expect(commitPlan(brokenStore, "u1", "{}")).rejects.toThrow(
      "insert failed",
    );
  });
});
