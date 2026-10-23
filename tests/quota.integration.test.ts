import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePlan, getCredits, getPlanResults } from "../src/demo-ai-app/operations";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) {
  throw new Error("Set TEST_DATABASE_URL to a dedicated PostgreSQL database whose name ends in _test.");
}
const db = new PrismaClient({ datasources: { db: { url } } });
const userIds: string[] = [];
type Context = Parameters<typeof generatePlan>[1];
let logs: ReturnType<typeof vi.spyOn>;

async function fixture(credits?: number, description: string | null = "学习 TypeScript") {
  const user = await db.user.create({ data: { credits } });
  userIds.push(user.id);
  if (description !== null) await db.task.create({ data: { userId: user.id, description } });
  // Deliberately stale auth balance: only the DB is authoritative.
  return {
    user: { ...user, credits: 999 },
    entities: { User: db.user, Task: db.task, PlanResult: db.planResult },
  } as unknown as Context;
}

function count(event: string) {
  return logs.mock.calls.filter(([line]) => {
    try { return JSON.parse(String(line)).event === event; } catch { return false; }
  }).length;
}

async function verify(id: string, context: Context, credits: number, results: number, calls: number) {
  const actualCredits = await getCredits(undefined, context);
  const actualResults = await db.planResult.count({ where: { userId: context.user!.id } });
  expect(actualCredits).toBe(credits);
  expect(actualResults).toBe(results);
  expect(count("mock-ai.started")).toBe(calls);
  console.log(JSON.stringify({ case: id, credits: actualCredits, results: actualResults, started: calls }));
}

beforeAll(() => db.$connect());
beforeEach(() => { logs = vi.spyOn(console, "info"); });
afterEach(async () => {
  vi.restoreAllMocks();
  // Only delete accounts created by this test; never truncate shared tables.
  await db.planResult.deleteMany({ where: { userId: { in: userIds } } });
  await db.task.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  userIds.length = 0;
});
afterAll(() => db.$disconnect());

describe("quota: actual PostgreSQL + original 500 ms mock provider", () => {
  it("A1: saves one schedule and consumes one credit", async () => {
    const ctx = await fixture();
    expect(await getCredits(undefined, ctx)).toBe(3);
    const result = await generatePlan({ hours: 8 }, ctx);
    expect(result.tasks[0].name).toBe("学习 TypeScript");
    expect(count("mock-ai.succeeded")).toBe(1);
    await verify("A1", ctx, 2, 1, 1);
    expect(JSON.parse((await getPlanResults(undefined, ctx))[0].content)).toEqual(result);
  });

  it("A2: zero DB balance blocks the provider despite stale auth", async () => {
    const ctx = await fixture(0);
    await expect(generatePlan({ hours: 8 }, ctx)).rejects.toMatchObject({ statusCode: 402 });
    await verify("A2", ctx, 0, 0, 0);
  });

  it("A3: explicit provider failure refunds, then a fresh retry succeeds", async () => {
    const ctx = await fixture(1, "[fail] 模拟失败");
    await expect(generatePlan({ hours: 8 }, ctx)).rejects.toMatchObject({ statusCode: 502 });
    expect(count("mock-ai.failed")).toBe(1);
    await verify("A3-failed", ctx, 1, 0, 1);
    await db.task.updateMany({ where: { userId: ctx.user!.id }, data: { description: "正常任务" } });
    await generatePlan({ hours: 8 }, ctx);
    await verify("A3-retry", ctx, 0, 1, 2);
  });

  it.each([["A4", 1], ["A5", 3]] as const)("%s: 10 simultaneous requests with %i credits", async (id, credits) => {
    const ctx = await fixture(credits);
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => generatePlan({ hours: 8 }, ctx)));
    expect(outcomes.filter(x => x.status === "fulfilled")).toHaveLength(credits);
    const rejected = outcomes.filter(x => x.status === "rejected");
    expect(rejected).toHaveLength(10 - credits);
    for (const result of rejected) expect(result.reason).toMatchObject({ statusCode: 402 });
    await verify(id, ctx, 0, credits, credits);
    console.log(JSON.stringify({ case: id, success: credits, rejected402: rejected.length }));
  });

  it("A6: concurrent failures return only their own reservations", async () => {
    const ctx = await fixture(1, "[fail]");
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => generatePlan({ hours: 8 }, ctx)));
    expect(outcomes.every(x => x.status === "rejected")).toBe(true);
    for (const result of outcomes) if (result.status === "rejected") expect([402, 502]).toContain(result.reason.statusCode);
    const calls = count("mock-ai.started");
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(count("mock-ai.failed")).toBe(calls);
    await verify("A6-failed", ctx, 1, 0, calls);
    await db.task.updateMany({ where: { userId: ctx.user!.id }, data: { description: "恢复" } });
    await generatePlan({ hours: 8 }, ctx);
    await verify("A6-retry", ctx, 0, 1, calls + 1);
  });

  it("A7: different accounts cannot consume each other's credits or results", async () => {
    const a = await fixture(1, "账号 A"), b = await fixture(1, "账号 B");
    await Promise.all([generatePlan({ hours: 8 }, a), generatePlan({ hours: 8 }, b)]);
    await verify("A7-a", a, 0, 1, 2);
    await verify("A7-b", b, 0, 1, 2);
    expect((await getPlanResults(undefined, a)).every(x => x.userId === a.user!.id)).toBe(true);
    expect((await getPlanResults(undefined, b)).every(x => x.userId === b.user!.id)).toBe(true);
  });

  it("A8: rejects unauthenticated, invalid and empty-task requests before calling AI", async () => {
    const ctx = await fixture(3, null);
    await expect(generatePlan({ hours: 8 }, { ...ctx, user: undefined })).rejects.toMatchObject({ statusCode: 401 });
    for (const hours of [0, -1, 25, NaN, Infinity]) {
      await expect(generatePlan({ hours }, ctx)).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(generatePlan({ hours: 8 }, ctx)).rejects.toMatchObject({ statusCode: 400 });
    await expect(getCredits(undefined, { ...ctx, user: undefined })).rejects.toMatchObject({ statusCode: 401 });
    await expect(getPlanResults(undefined, { ...ctx, user: undefined })).rejects.toMatchObject({ statusCode: 401 });
    await verify("A8", ctx, 3, 0, 0);
  });

  it("A9: a definite save rejection refunds exactly once", async () => {
    const ctx = await fixture(1);
    vi.spyOn(db.planResult, "create").mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("injected FK rejection", { code: "P2003", clientVersion: "5.19.1" }));
    await expect(generatePlan({ hours: 8 }, ctx)).rejects.toMatchObject({ statusCode: 500 });
    await verify("A9", ctx, 1, 0, 1);
  });

  it("A10: failed compensation is visible and never promises a refund", async () => {
    const ctx = await fixture(1, "[fail]");
    const errors = vi.spyOn(console, "error");
    vi.spyOn(db.user, "update").mockRejectedValueOnce(new Error("injected refund outage"));
    await expect(generatePlan({ hours: 8 }, ctx)).rejects.toMatchObject({ statusCode: 503 });
    expect(errors.mock.calls.some(([event]) => event === "quota.refund_failed")).toBe(true);
    await verify("A10", ctx, 0, 0, 1);
  });

  it("A11: ambiguous save failure retains reservation for reconciliation", async () => {
    const ctx = await fixture(1);
    const errors = vi.spyOn(console, "error");
    vi.spyOn(db.planResult, "create").mockRejectedValueOnce(new Error("injected lost DB response"));
    await expect(generatePlan({ hours: 8 }, ctx)).rejects.toMatchObject({ statusCode: 503 });
    expect(errors.mock.calls.some(([event]) => event === "quota.save_uncertain")).toBe(true);
    await verify("A11", ctx, 0, 0, 1);
  });

  it("A11-committed: a lost response after INSERT must not make a saved schedule free", async () => {
    const ctx = await fixture(1);
    const create = db.planResult.create.bind(db.planResult);
    vi.spyOn(db.planResult, "create").mockImplementationOnce(async (args) => {
      await create(args);
      throw new Error("injected response loss after committed INSERT");
    });
    await expect(generatePlan({ hours: 8 }, ctx)).rejects.toMatchObject({ statusCode: 503 });
    await verify("A11-committed", ctx, 0, 1, 1);
  });
});
