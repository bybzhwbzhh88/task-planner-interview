import { describe, expect, it } from "vitest";
import { refundCredit, tryConsumeCredit, type CreditsClient } from "./credits";

const USER = "user-1";

type UpdateManyArgs = Parameters<CreditsClient["user"]["updateMany"]>[0];
type UpdateArgs = Parameters<CreditsClient["user"]["update"]>[0];

/**
 * 假存储：把「判断余额」和「扣减」合成一次同步操作，
 * 对应数据库里单条 UPDATE ... WHERE credits > 0 的原子性。
 *
 * updateMany 在被调用时立即完成判定，返回的 Promise 只是结果载体——
 * 所以两个请求先后抵达时，第二个看到的是已经扣完的余额，
 * 这正是并发用例要复现的时序。真实数据库的串行化能力由
 * AC-05 / AC-06 的端到端脚本验证，这里验证的是调用方如何使用结果。
 */
function createFakeClient(initialCredits: number) {
  let credits = initialCredits;

  const client: CreditsClient = {
    user: {
      async updateMany(args: UpdateManyArgs) {
        if (args.where.id !== USER || !(credits > args.where.credits.gt)) {
          return { count: 0 };
        }
        credits -= args.data.credits.decrement;
        return { count: 1 };
      },
      async update(args: UpdateArgs) {
        if (args.where.id !== USER) {
          throw new Error(`unexpected user: ${args.where.id}`);
        }
        credits += args.data.credits.increment;
        return {};
      },
    },
  };

  return { client, balance: () => credits };
}

describe("tryConsumeCredit", () => {
  it("余额大于 0 时扣 1 次并返回 true", async () => {
    const { client, balance } = createFakeClient(3);
    await expect(tryConsumeCredit(USER, client)).resolves.toBe(true);
    expect(balance()).toBe(2);
  });

  it("余额为 0 时返回 false，且不修改数据", async () => {
    const { client, balance } = createFakeClient(0);
    await expect(tryConsumeCredit(USER, client)).resolves.toBe(false);
    expect(balance()).toBe(0);
  });

  it("连续扣减不会跨过 0", async () => {
    const { client, balance } = createFakeClient(2);
    const results: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await tryConsumeCredit(USER, client));
    }
    expect(results).toEqual([true, true, false, false]);
    expect(balance()).toBe(0);
  });

  it("余额 1 时两个并发请求只有一个扣得到", async () => {
    const { client, balance } = createFakeClient(1);
    const results = await Promise.all([
      tryConsumeCredit(USER, client),
      tryConsumeCredit(USER, client),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(balance()).toBe(0);
  });

  it("账号不匹配时扣不到", async () => {
    const { client } = createFakeClient(5);
    await expect(tryConsumeCredit("someone-else", client)).resolves.toBe(false);
  });
});

describe("refundCredit", () => {
  it("退还算作一次加回", async () => {
    const { client, balance } = createFakeClient(1);
    await tryConsumeCredit(USER, client);
    expect(balance()).toBe(0);

    await refundCredit(USER, client);
    expect(balance()).toBe(1);
  });

  it("失败路径的净变化为 0：扣一次再退一次", async () => {
    const { client, balance } = createFakeClient(2);
    await tryConsumeCredit(USER, client);
    await refundCredit(USER, client);
    expect(balance()).toBe(2);
  });
});
