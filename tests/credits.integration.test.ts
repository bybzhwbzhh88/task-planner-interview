import type { Prisma } from "@prisma/client";
import type { AuthUser } from "wasp/auth";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { generatePlan, getCredits } from "../src/demo-ai-app/operations";
import { prisma } from "./support/wasp-server";

const entities = {
  User: prisma.user,
  Task: prisma.task,
  PlanResult: prisma.planResult,
};
let info: MockInstance<typeof console.info>;

// Each case owns its user and removes only that user's rows, even after an assertion fails.
async function withUser(
  credits: number,
  description: string,
  check: (user: AuthUser) => Promise<void>,
) {
  const record = await prisma.user.create({
    data: { credits, tasks: { create: { description } } },
  });
  const user: AuthUser = {
    ...record,
    identities: { username: { id: record.id } },
    getFirstProviderUserId: () => record.id,
  };
  try {
    await check(user);
  } finally {
    await prisma.planResult.deleteMany({ where: { userId: user.id } });
    await prisma.task.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
}

async function expectDatabase(user: AuthUser, credits: number, planCount: number) {
  const [currentUser, savedPlans] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    prisma.planResult.findMany({ where: { userId: user.id } }),
  ]);
  expect(currentUser.credits).toBe(credits);
  expect(savedPlans).toHaveLength(planCount);
  // This context retains the original credits, so the query must read the database.
  expect(await getCredits(undefined, { user, entities })).toBe(credits);
  return savedPlans;
}

function expectEvents(started: number, succeeded: number, failed: number) {
  const events = info.mock.calls.map(([message]) => JSON.parse(message));
  expect(events.filter(({ event }) => event === "mock-ai.started")).toHaveLength(started);
  expect(events.filter(({ event }) => event === "mock-ai.succeeded")).toHaveLength(succeeded);
  expect(events.filter(({ event }) => event === "mock-ai.failed")).toHaveLength(failed);
  const starts = events.filter(({ event }) => event === "mock-ai.started").map(({ callId }) => callId);
  const ends = events.filter(({ event }) => event !== "mock-ai.started").map(({ callId }) => callId);
  expect(new Set(starts).size).toBe(started);
  expect(ends.sort()).toEqual(starts.sort());
}

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await prisma.$disconnect(); });
beforeEach(() => { info = vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe("PostgreSQL credit transactions (SPEC A1–A8)", () => {
  it("A1: success saves the returned schedule and consumes one of three credits", async () => {
    await withUser(3, "准备面试", async (user) => {
      const schedule = await generatePlan({ hours: 3 }, { user, entities });
      expect(schedule.tasks).toEqual([{ name: "准备面试", priority: "medium" }]);
      expect(schedule.taskItems).toHaveLength(3);
      const plans = await expectDatabase(user, 2, 1);
      expect(JSON.parse(plans[0].content)).toEqual(schedule);
      expectEvents(1, 1, 0);
    });
  });

  it("A2: database zero credits rejects stale context credits before calling the provider", async () => {
    await withUser(0, "准备面试", async (user) => {
      const staleContext = { user: { ...user, credits: 3 }, entities };
      await expect(generatePlan({ hours: 3 }, staleContext)).rejects.toMatchObject({ statusCode: 402 });
      expect(await getCredits(undefined, staleContext)).toBe(0);
      await expectDatabase(user, 0, 0);
      expectEvents(0, 0, 0);
    });
  });

  it("A3: explicit provider failure refunds the credit and permits retry", async () => {
    await withUser(1, "[fail] 准备面试", async (user) => {
      await expect(generatePlan({ hours: 3 }, { user, entities })).rejects.toMatchObject({ statusCode: 503 });
      await expectDatabase(user, 1, 0);
      expectEvents(1, 0, 1);

      await prisma.task.deleteMany({ where: { userId: user.id } });
      await prisma.task.create({ data: { userId: user.id, description: "准备面试" } });
      const schedule = await generatePlan({ hours: 3 }, { user, entities });
      expect(schedule.tasks).toHaveLength(1);
      await expectDatabase(user, 0, 1);
      expectEvents(2, 1, 1);
    });
  });

  it.each([1, 2, 3])("A4 round %i: five concurrent requests can consume the last credit only once", async () => {
    await withUser(1, "准备面试", async (user) => {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => generatePlan({ hours: 3 }, { user, entities })),
      );
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((result) => result.status === "rejected");
      expect(rejected).toHaveLength(4);
      for (const result of rejected) expect(result.reason).toMatchObject({ statusCode: 402 });
      await expectDatabase(user, 0, 1);
      expectEvents(1, 1, 0);
    });
  });

  it("A5: five concurrent requests with three credits produce exactly three schedules", async () => {
    await withUser(3, "准备面试", async (user) => {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => generatePlan({ hours: 3 }, { user, entities })),
      );
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(3);
      const rejected = results.filter((result) => result.status === "rejected");
      expect(rejected).toHaveLength(2);
      for (const result of rejected) expect(result.reason).toMatchObject({ statusCode: 402 });
      await expectDatabase(user, 0, 3);
      expectEvents(3, 3, 0);
    });
  });

  it("A6: a waiting request can reserve the credit released by another request's failure", async () => {
    await withUser(1, "[fail] 准备面试", async (user) => {
      const results = await Promise.allSettled(
        Array.from({ length: 2 }, () => generatePlan({ hours: 3 }, { user, entities })),
      );
      for (const result of results) {
        expect(result).toMatchObject({ status: "rejected", reason: { statusCode: 503 } });
      }
      await expectDatabase(user, 1, 0);
      expectEvents(2, 0, 2);
    });
  });

  it("A7: persistence failure propagates and rolls back the real credit update", async () => {
    await withUser(1, "准备面试", async (user) => {
      const saveError = new Error("Injected PlanResult persistence failure");
      const realTransaction = prisma.$transaction.bind(prisma);
      // Keep the real transaction/row lock; inject only the final persistence failure.
      const transactionSpy = vi.spyOn(prisma, "$transaction").mockImplementation(
        ((callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { maxWait?: number; timeout?: number }) => realTransaction(async (tx) => {
          const createSpy = vi.spyOn(tx.planResult, "create").mockRejectedValue(saveError);
          try {
            return await callback(tx);
          } finally {
            createSpy.mockRestore();
          }
        }, options)) as typeof prisma.$transaction,
      );
      try {
        await expect(generatePlan({ hours: 3 }, { user, entities })).rejects.toBe(saveError);
      } finally {
        transactionSpy.mockRestore();
      }
      await expectDatabase(user, 1, 0);
      expectEvents(1, 1, 0);
    });
  });

  it("A8: unauthenticated generation and credit query return 401 without changing data", async () => {
    await withUser(1, "准备面试", async (user) => {
      await expect(generatePlan({ hours: 3 }, { entities })).rejects.toMatchObject({ statusCode: 401 });
      await expect(getCredits(undefined, { entities })).rejects.toMatchObject({ statusCode: 401 });
      await expectDatabase(user, 1, 0);
      expectEvents(0, 0, 0);
    });
  });
});
