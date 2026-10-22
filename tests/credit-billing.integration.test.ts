import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  generatePlanWithCredit,
  InsufficientCreditsError,
  ScheduleGenerationError,
} from "../src/demo-ai-app/creditBilling";
import { generateMockSchedule } from "../src/demo-ai-app/mockAi";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for credit billing tests");
}

const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl } },
});
const createdUserIds: string[] = [];
const tasks = [{ description: "写周报", time: "1" }];

async function createUser(credits: number) {
  const user = await prisma.user.create({ data: { credits } });
  createdUserIds.push(user.id);
  return user;
}

async function readCredits(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { credits: true },
  });
  return user.credits;
}

async function countPlanResults(userId: string) {
  return prisma.planResult.count({ where: { userId } });
}

function readMockAiEvents(infoSpy: ReturnType<typeof vi.spyOn>) {
  return infoSpy.mock.calls
    .map(([entry]) => JSON.parse(String(entry)) as { event?: string })
    .filter((entry) => entry.event?.startsWith("mock-ai."));
}

afterEach(async () => {
  for (const userId of createdUserIds.splice(0)) {
    await prisma.planResult.deleteMany({ where: { userId } });
    await prisma.task.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  }
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("credit-billed plan generation", () => {
  it("AC-01 consumes one credit after a successful generation", async () => {
    const user = await createUser(3);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const result = await generatePlanWithCredit({
      prisma,
      userId: user.id,
      generateSchedule: () => generateMockSchedule(tasks, 8),
    });

    expect(result.schedule.tasks).toHaveLength(1);
    expect(result.remainingCredits).toBe(2);
    await expect(readCredits(user.id)).resolves.toBe(2);
    await expect(countPlanResults(user.id)).resolves.toBe(1);

    const events = readMockAiEvents(infoSpy);
    expect(events.filter((event) => event.event === "mock-ai.started")).toHaveLength(1);
    expect(events.filter((event) => event.event === "mock-ai.succeeded")).toHaveLength(1);
  });

  it("AC-02 rejects without calling the provider when credits are exhausted", async () => {
    const user = await createUser(0);
    const generateSchedule = vi.fn();

    await expect(
      generatePlanWithCredit({
        prisma,
        userId: user.id,
        generateSchedule,
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(generateSchedule).not.toHaveBeenCalled();
    await expect(readCredits(user.id)).resolves.toBe(0);
    await expect(countPlanResults(user.id)).resolves.toBe(0);
  });

  it("AC-03 refunds the reservation when the provider explicitly fails", async () => {
    const user = await createUser(3);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const failingTasks = [{ description: "[fail] 写周报", time: "1" }];

    await expect(
      generatePlanWithCredit({
        prisma,
        userId: user.id,
        generateSchedule: () => generateMockSchedule(failingTasks, 8),
      }),
    ).rejects.toBeInstanceOf(ScheduleGenerationError);

    await expect(readCredits(user.id)).resolves.toBe(3);
    await expect(countPlanResults(user.id)).resolves.toBe(0);

    const events = readMockAiEvents(infoSpy);
    expect(events.filter((event) => event.event === "mock-ai.started")).toHaveLength(1);
    expect(events.filter((event) => event.event === "mock-ai.failed")).toHaveLength(1);
  });

  it.each([{ credits: 1 }, { credits: 3 }])(
    "AC-04/05 never overdraws when 5 requests race with $credits credits",
    async ({ credits }) => {
      const user = await createUser(credits);
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          generatePlanWithCredit({
            prisma,
            userId: user.id,
            generateSchedule: () => generateMockSchedule(tasks, 8),
          }),
        ),
      );

      const successes = results.filter((result) => result.status === "fulfilled");
      const insufficient = results.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof InsufficientCreditsError,
      );

      expect(successes).toHaveLength(credits);
      expect(insufficient).toHaveLength(5 - credits);
      await expect(readCredits(user.id)).resolves.toBe(0);
      await expect(countPlanResults(user.id)).resolves.toBe(credits);

      const events = readMockAiEvents(infoSpy);
      expect(events.filter((event) => event.event === "mock-ai.started")).toHaveLength(credits);
      expect(events.filter((event) => event.event === "mock-ai.succeeded")).toHaveLength(credits);
    },
  );
});
