import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePlan, getCredits, getPlanResults } from "../../src/demo-ai-app/operations";
import { generatePlanWithCredits } from "../../src/demo-ai-app/generatePlanWithCredits";
import { generateMockSchedule } from "../../src/demo-ai-app/mockAi";
import { prisma } from "../helpers/waspServer";

if (!process.env.TEST_DATABASE_URL || !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")) {
  throw new Error("Use npm run test:integration with a dedicated TEST_DATABASE_URL ending in _test.");
}

const users: string[] = [];
let events: { event: string; callId: string }[] = [];
const context = (id: string, credits = 999) => ({
  user: { id, credits },
  entities: { User: prisma.user, PlanResult: prisma.planResult },
}) as unknown as Parameters<typeof generatePlan>[1];
const call = (id: string, credits = 999) => generatePlan({ hours: 8 }, context(id, credits));
const count = (name: string) => events.filter((event) => event.event === `mock-ai.${name}`).length;

async function user(credits: number, description: string | null = "写验证记录") {
  const result = await prisma.user.create({
    data: { credits, ...(description === null ? {} : { tasks: { create: { description } } }) },
  });
  users.push(result.id);
  return result.id;
}

async function assertState(id: string, credits: number, results: number) {
  expect(await getCredits(undefined, context(id))).toBe(credits);
  expect(await getPlanResults(undefined, context(id))).toHaveLength(results);
}

function evidence(caseId: string, details: object) {
  // Kept in test output for a reviewer; no user credentials or phone numbers.
  process.stdout.write(JSON.stringify({ case: caseId, ...details, started: count("started"),
    succeeded: count("succeeded"), failed: count("failed") }) + "\n");
}

beforeEach(() => {
  events = [];
  vi.spyOn(console, "info").mockImplementation((message: string) => {
    events.push(JSON.parse(message));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  const where = { userId: { in: [...users] } };
  await prisma.planResult.deleteMany({ where });
  await prisma.task.deleteMany({ where });
  await prisma.user.deleteMany({ where: { id: { in: [...users] } } });
  users.length = 0;
});
afterAll(() => prisma.$disconnect());

describe("real PostgreSQL quota invariants", () => {
  it("A1: commits one debit and one result, even with a stale zero-credit auth snapshot", async () => {
    const id = await user(3);
    const schedule = await call(id, 0);
    await assertState(id, 2, 1);
    expect(JSON.parse((await getPlanResults(undefined, context(id)))[0].content)).toEqual(schedule);
    expect(count("started")).toBe(1);
    expect(count("succeeded")).toBe(1);
    evidence("A1", { credits: 2, results: 1 });
  });

  it("A2: rejects zero credits before the model, ignoring a stale rich auth snapshot", async () => {
    const id = await user(0, "[fail]");
    await expect(call(id)).rejects.toMatchObject({ statusCode: 402 });
    await assertState(id, 0, 0);
    expect(count("started")).toBe(0);
    evidence("A2", { status: 402, credits: 0, results: 0 });
  });

  it("A3: rolls back provider failure and allows a successful retry", async () => {
    const id = await user(1, "[fail]");
    await expect(call(id)).rejects.toMatchObject({ statusCode: 502 });
    await assertState(id, 1, 0);
    expect(count("failed")).toBe(1);
    evidence("A3-failure", { status: 502, credits: 1, results: 0 });
    await prisma.task.updateMany({ where: { userId: id }, data: { description: "修复后重试" } });
    await call(id);
    await assertState(id, 0, 1);
    expect(count("started")).toBe(2);
    expect(count("succeeded")).toBe(1);
    evidence("A3-retry", { credits: 0, results: 1 });
  });

  it.each([1, 3])("A4/A5: ten requests compete for %s credits without excess model calls", async (credits) => {
    const id = await user(credits);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => call(id)));
    const success = results.filter((result) => result.status === "fulfilled");
    const failures = results.filter((result) => result.status === "rejected");
    expect(success).toHaveLength(credits);
    expect(failures).toHaveLength(10 - credits);
    failures.forEach((result) => expect(result.reason).toMatchObject({ statusCode: 402 }));
    await assertState(id, 0, credits);
    expect(count("started")).toBe(credits);
    expect(count("succeeded")).toBe(credits);
    expect(new Set(events.filter((event) => event.event === "mock-ai.started").map((event) => event.callId)).size).toBe(credits);
    evidence(credits === 1 ? "A4" : "A5", { requests: 10, success: success.length,
      rejected402: failures.length, credits: 0, results: credits });
  });

  it("A6: the waiting request can use a credit released by rollback", async () => {
    const id = await user(1);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failed = generatePlanWithCredits(prisma, id, 8, async (tasks, hours) => {
      entered.resolve();
      await release.promise;
      return generateMockSchedule(tasks.map((task) => ({ ...task, description: "[fail]" })), hours);
    }).catch((error: unknown) => error);
    await entered.promise;
    const success = call(id);
    release.resolve();
    expect(await failed).toMatchObject({ reason: "provider-failed" });
    await success;
    await assertState(id, 0, 1);
    expect(count("started")).toBe(2);
    expect(count("failed")).toBe(1);
    expect(count("succeeded")).toBe(1);
    evidence("A6", { credits: 0, results: 1 });
  });

  it("A7: a real foreign-key failure while saving rolls back the debit", async () => {
    const id = await user(1);
    const transaction = prisma.$transaction.bind(prisma);
    // Execute the real transaction and real INSERT, but inject an invalid
    // owner only at the save boundary to force PostgreSQL's FK constraint.
    const brokenSave = {
      $transaction: (fn: Parameters<typeof prisma.$transaction>[0], options: object) =>
        transaction(async (tx) => {
          const original = tx.planResult.create.bind(tx.planResult);
          tx.planResult.create = ((args: Parameters<typeof original>[0]) => original({
            ...args, data: { ...args.data, userId: "quota-test-missing-owner" },
          })) as typeof original;
          return (fn as (value: typeof tx) => Promise<unknown>)(tx);
        }, options),
    } as unknown as Pick<typeof prisma, "$transaction">;
    await expect(generatePlanWithCredits(brokenSave, id, 8, generateMockSchedule))
      .rejects.toMatchObject({ code: "P2003" });
    await assertState(id, 1, 0);
    expect(count("started")).toBe(1);
    expect(count("succeeded")).toBe(1);
    evidence("A7", { databaseError: "P2003", credits: 1, results: 0 });
  });

  it("A8: an empty task list rolls back and never calls the model", async () => {
    const id = await user(1, null);
    await expect(call(id)).rejects.toMatchObject({ statusCode: 400 });
    await assertState(id, 1, 0);
    expect(count("started")).toBe(0);
    evidence("A8-empty", { status: 400, credits: 1, results: 0 });
  });

  it("A9: another account completes while the first account's provider is paused", async () => {
    const alice = await user(1, "仅属于 A");
    const bob = await user(1, "仅属于 B");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const a = generatePlanWithCredits(prisma, alice, 8, async (tasks, hours) => {
      entered.resolve();
      await release.promise;
      return generateMockSchedule(tasks, hours);
    });
    await entered.promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const b = await Promise.race([
        call(bob), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("B was blocked by A")), 4_000);
        }),
      ]);
      expect(b.tasks.map((task) => task.name)).toEqual(["仅属于 B"]);
    } finally {
      clearTimeout(timer);
      release.resolve();
    }
    expect((await a).tasks.map((task) => task.name)).toEqual(["仅属于 A"]);
    await assertState(alice, 0, 1);
    await assertState(bob, 0, 1);
    expect(count("started")).toBe(2);
    evidence("A9", { independentAccounts: 2, creditsEach: 0, resultsEach: 1 });
  });
});
