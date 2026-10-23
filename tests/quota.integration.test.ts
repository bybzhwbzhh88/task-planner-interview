import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { generateWithQuota } from "../src/demo-ai-app/quota";
import { generateMockSchedule } from "../src/demo-ai-app/mockAi";

const url = process.env.QUOTA_TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) {
  throw new Error("Set QUOTA_TEST_DATABASE_URL to a dedicated database ending in _test");
}
const db = new PrismaClient({ datasources: { db: { url } } });
const users: string[] = [];
let started = 0;

beforeEach(() => {
  started = 0;
  vi.spyOn(console, "info").mockImplementation((line) => {
    if (typeof line === "string" && JSON.parse(line).event === "mock-ai.started") started++;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  // Delete only records created by this test run, never reset a database.
  await db.planResult.deleteMany({ where: { userId: { in: users } } });
  await db.task.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  users.length = 0;
});
afterAll(() => db.$disconnect());

async function user(credits: number) {
  const id = randomUUID();
  await db.user.create({ data: { id, credits } });
  users.push(id);
  return id;
}
const provider = (fail = false) => generateMockSchedule([{ description: fail ? "[fail]" : "学习", time: "1" }], 8);
const run = (id: string, fail = false) => generateWithQuota(db, id, () => provider(fail));
async function state(id: string, credits: number, plans: number) {
  expect((await db.user.findUniqueOrThrow({ where: { id } })).credits).toBe(credits);
  expect(await db.planResult.count({ where: { userId: id } })).toBe(plans);
}

test("A1: success charges once and persists result", async () => {
  const id = await user(3);
  await run(id);
  await state(id, 2, 1);
  expect(started).toBe(1);
});
test("A2: zero balance prevents provider invocation", async () => {
  const id = await user(0);
  await expect(run(id)).rejects.toMatchObject({ statusCode: 402 });
  await state(id, 0, 0);
  expect(started).toBe(0);
});
test("A3/A6: explicit failure refunds and allows a successful retry", async () => {
  const id = await user(1);
  await expect(run(id, true)).rejects.toMatchObject({ statusCode: 502 });
  await state(id, 1, 0);
  await run(id);
  await state(id, 0, 1);
  expect(started).toBe(2);
});
test.each([1, 3])("A4/A5: 20 rounds of 10 concurrent calls with %i credits", async (credits) => {
  for (let round = 0; round < 20; round++) {
    const id = await user(credits);
    const before = started;
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => run(id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(credits);
    for (const r of results) if (r.status === "rejected") expect(r.reason.statusCode).toBe(402);
    await state(id, 0, credits);
    expect(started - before).toBe(credits);
  }
});
test("A7: separate users have independent balances and results", async () => {
  const a = await user(1);
  const b = await user(1);
  await Promise.all([run(a), run(b)]);
  await state(a, 0, 1);
  await state(b, 0, 1);
  expect(started).toBe(2);
});
test("A9: confirmed save rejection refunds exactly once", async () => {
  const id = await user(1);
  vi.spyOn(db.planResult, "create").mockRejectedValueOnce(
    new Prisma.PrismaClientKnownRequestError("constraint rejection", { code: "P2003", clientVersion: "5.19.1" }),
  );
  await expect(run(id)).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining("已返还") });
  await state(id, 1, 0);
});
test("A10: failed refund never claims the balance was restored", async () => {
  const id = await user(1);
  vi.spyOn(db.user, "update").mockRejectedValueOnce(new Error("injected refund failure"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(run(id, true)).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining("未确认") });
  await state(id, 0, 0);
  expect(log).toHaveBeenCalledWith("quota.refund-failed", expect.objectContaining({ userId: id }));
});
test("unknown save outcome is not blindly refunded", async () => {
  const id = await user(1);
  vi.spyOn(db.planResult, "create").mockRejectedValueOnce(new Error("connection lost"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(run(id)).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining("待核查") });
  await state(id, 0, 0);
});
test("null provider response refunds", async () => {
  const id = await user(1);
  await expect(generateWithQuota(db, id, async () => null)).rejects.toMatchObject({ statusCode: 502 });
  await state(id, 1, 0);
});
