import { PrismaClient } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { generatePlanWithQuota, type GenerationDb } from "./planGeneration";

// Acceptance cases AC-1..AC-6 from SPEC.md §6 run against the disposable test
// database (scripts/test-db-setup.sh). AC-5 is the manual browser checklist.

const db = new PrismaClient();
const createdUserIds: string[] = [];

async function createUser(credits: number): Promise<string> {
  const user = await db.user.create({ data: { credits } });
  createdUserIds.push(user.id);
  return user.id;
}

function addTask(userId: string, description: string) {
  return db.task.create({ data: { userId, description } });
}

async function creditsOf(userId: string): Promise<number> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  return user.credits;
}

let infoSpy: MockInstance<typeof console.info>;

/** JSON log events with the given `event` field, e.g. mock-ai.started. */
function loggedEvents(name: string): Record<string, string>[] {
  return infoSpy.mock.calls
    .map(([msg]) => String(msg))
    .flatMap((msg) => {
      try {
        const parsed = JSON.parse(msg) as Record<string, string>;
        return parsed.event === name ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

/** Narrow a non-matching outcome into a test failure with a readable message. */
function expectStatus<T extends string>(
  outcome: { status: string },
  status: T,
): asserts outcome is { status: T } {
  if (outcome.status !== status) {
    throw new Error(`expected status "${status}", got "${outcome.status}"`);
  }
}

beforeEach(() => {
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Clean up in dependency order (PlanResult/Task reference the user).
  await db.planResult.deleteMany({ where: { userId: { in: createdUserIds } } });
  await db.task.deleteMany({ where: { userId: { in: createdUserIds } } });
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  createdUserIds.length = 0;
});

afterAll(async () => {
  await db.$disconnect();
});

describe("generatePlanWithQuota", () => {
  it("AC-1: spends exactly one credit on a successful generation", async () => {
    const userId = await createUser(3);
    await addTask(userId, "写周报");
    await addTask(userId, "复盘项目");

    const outcome = await generatePlanWithQuota(db, userId, 8);

    expectStatus(outcome, "success");
    expect(outcome.schedule.tasks).toHaveLength(2);
    expect(await creditsOf(userId)).toBe(2);
    expect(await db.planResult.count({ where: { userId } })).toBe(1);
    const stored = await db.planResult.findFirstOrThrow({ where: { userId } });
    expect(JSON.parse(stored.content)).toEqual(outcome.schedule);

    const started = loggedEvents("mock-ai.started");
    const succeeded = loggedEvents("mock-ai.succeeded");
    expect(started).toHaveLength(1);
    expect(succeeded).toHaveLength(1);
    expect(started[0].callId).toBe(succeeded[0].callId);
    expect(loggedEvents("credits.reserved")).toHaveLength(1);
  });

  it("AC-2: rejects without calling the provider when out of credits", async () => {
    const userId = await createUser(0);
    await addTask(userId, "写周报");

    const outcome = await generatePlanWithQuota(db, userId, 8);

    expect(outcome).toEqual({ status: "insufficient_credits" });
    expect(await creditsOf(userId)).toBe(0);
    expect(await db.planResult.count({ where: { userId } })).toBe(0);
    // The provider call must not be initiated at all.
    expect(loggedEvents("mock-ai.started")).toHaveLength(0);
    expect(loggedEvents("credits.reserved")).toHaveLength(0);
  });

  it("AC-3: refunds the reserved credit when the provider fails", async () => {
    const userId = await createUser(2);
    await addTask(userId, "包含 [fail] 的任务");

    const outcome = await generatePlanWithQuota(db, userId, 8);

    expectStatus(outcome, "provider_failed");
    expect(await creditsOf(userId)).toBe(2);
    expect(await db.planResult.count({ where: { userId } })).toBe(0);

    const started = loggedEvents("mock-ai.started");
    const failed = loggedEvents("mock-ai.failed");
    expect(started).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(started[0].callId).toBe(failed[0].callId);
    expect(loggedEvents("mock-ai.succeeded")).toHaveLength(0);
    expect(loggedEvents("credits.refunded")).toHaveLength(1);
  });

  it("AC-4: one credit, ten concurrent requests → one success, no overdraft", async () => {
    const userId = await createUser(1);
    await addTask(userId, "写周报");

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => generatePlanWithQuota(db, userId, 8)),
    );

    const statuses = outcomes.map((o) => o.status);
    expect(statuses.filter((s) => s === "success")).toHaveLength(1);
    expect(statuses.filter((s) => s === "insufficient_credits")).toHaveLength(9);
    // Never negative, and no phantom result rows for rejected requests.
    expect(await creditsOf(userId)).toBe(0);
    expect(await db.planResult.count({ where: { userId } })).toBe(1);
    // The provider is invoked once per reserved credit, never more.
    expect(loggedEvents("mock-ai.started")).toHaveLength(1);
    expect(loggedEvents("credits.reserved")).toHaveLength(1);
  });

  it("AC-4: three credits, twenty concurrent requests → three successes", async () => {
    const userId = await createUser(3);
    await addTask(userId, "写周报");

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => generatePlanWithQuota(db, userId, 8)),
    );

    const statuses = outcomes.map((o) => o.status);
    expect(statuses.filter((s) => s === "success")).toHaveLength(3);
    expect(statuses.filter((s) => s === "insufficient_credits")).toHaveLength(17);
    expect(await creditsOf(userId)).toBe(0);
    expect(await db.planResult.count({ where: { userId } })).toBe(3);
    expect(loggedEvents("mock-ai.started")).toHaveLength(3);
    expect(loggedEvents("credits.reserved")).toHaveLength(3);
  });

  it("AC-6: empty task list → no reservation, no provider call", async () => {
    const userId = await createUser(3);

    const outcome = await generatePlanWithQuota(db, userId, 8);

    expect(outcome).toEqual({ status: "no_tasks" });
    expect(await creditsOf(userId)).toBe(3);
    expect(await db.planResult.count({ where: { userId } })).toBe(0);
    expect(loggedEvents("mock-ai.started")).toHaveLength(0);
    expect(loggedEvents("credits.reserved")).toHaveLength(0);
  });

  it("E3: refunds the reserved credit when persisting the result fails", async () => {
    const userId = await createUser(1);
    await addTask(userId, "写周报");
    const failingDb = {
      user: db.user,
      task: db.task,
      planResult: {
        create: () => Promise.reject(new Error("simulated persistence failure")),
      },
    } as unknown as GenerationDb;

    const outcome = await generatePlanWithQuota(failingDb, userId, 8);

    expectStatus(outcome, "provider_failed");
    expect(await creditsOf(userId)).toBe(1);
    expect(await db.planResult.count({ where: { userId } })).toBe(0);
    expect(loggedEvents("mock-ai.started")).toHaveLength(1);
    expect(loggedEvents("credits.refunded")).toHaveLength(1);
  });
});
