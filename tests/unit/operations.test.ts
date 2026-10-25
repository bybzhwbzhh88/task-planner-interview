import { describe, expect, it, vi } from "vitest";

vi.mock("wasp/server", () => ({
  HttpError: class extends Error { constructor(public statusCode: number, message?: string, public data?: unknown) { super(message); } },
  prisma: {},
}));
const { generatePlan, getCredits, getLatestPlan } = await import("../../src/demo-ai-app/operations");
const run = (fn: unknown, args: unknown, ctx: unknown): Promise<unknown> => (fn as (a: unknown, c: unknown) => Promise<unknown>)(args, ctx);

describe("Wasp 入口", () => {
  it("未登录生成立即返回401", async () => {
    await expect(run(generatePlan, { hours: 8 }, { entities: {} })).rejects.toMatchObject({ statusCode: 401 });
  });
  it.each([getCredits, getLatestPlan])("伪造账号不能读取其他账号数据", async query => {
    await expect(run(query, { viewerId: "other" }, { user: { id: "u1" }, entities: {} })).rejects.toMatchObject({ statusCode: 403 });
  });
  it.each([getCredits, getLatestPlan])("未提供账号缓存标识则拒绝查询", async query => {
    await expect(run(query, undefined, { user: { id: "u1" }, entities: {} })).rejects.toMatchObject({ statusCode: 400 });
  });
  it("余额读取按当前账号过滤", async () => {
    const findUnique = vi.fn(async () => ({ credits: 2 }));
    expect(await run(getCredits, { viewerId: "u1" }, { user: { id: "u1" }, entities: { User: { findUnique } } })).toEqual({ availableCredits: 2 });
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "u1" }, select: { credits: true } });
  });
  it("无额度入口返回402且不保存结果", async () => {
    const create = vi.fn();
    await expect(run(generatePlan, { hours: 8 }, { user: { id: "u1", credits: 999 }, entities: {
      Task: { findMany: async () => [{ description: "任务", time: "1" }] }, User: { updateMany: async () => ({ count: 0 }) }, PlanResult: { create },
    } })).rejects.toMatchObject({ statusCode: 402 });
    expect(create).not.toHaveBeenCalled();
  });
});
