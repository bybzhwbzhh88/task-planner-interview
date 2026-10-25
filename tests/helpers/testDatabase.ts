import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { vi } from "vitest";
import { resolveTestDatabaseUrl } from "../../scripts/testDatabase.mjs";
import type { GenerationDependencies } from "../../src/demo-ai-app/planGeneration";
import { createPrismaPlanStore } from "../../src/demo-ai-app/planStore";
import { generateMockSchedule } from "../../src/demo-ai-app/mockAi";

export type CapturedEvent = {
  event: string;
  callId?: string;
  requestId?: string;
  userId?: string;
  phase?: string;
  code?: string;
};

export type TestAccount = { client: PrismaClient; userId: string; url: string };

export type TestFixture = TestAccount & {
  deps: GenerationDependencies;
  events: CapturedEvent[];
};

export async function createTestAccount(
  credits: number,
  descriptions: string[],
  url = resolveTestDatabaseUrl(),
): Promise<TestAccount> {
  const client = new PrismaClient({ datasources: { db: { url } } });
  const userId = `quota-test-${randomUUID()}`;
  try {
    await client.user.create({ data: { id: userId, credits } });
    if (descriptions.length > 0) {
      await client.task.createMany({
        data: descriptions.map((description) => ({ userId, description })),
      });
    }
  } catch (error) {
    await client.$disconnect();
    throw error;
  }
  return { client, userId, url };
}

export async function deleteTestAccount(account: TestAccount): Promise<void> {
  try {
    await account.client.$transaction([
      account.client.planResult.deleteMany({ where: { userId: account.userId } }),
      account.client.task.deleteMany({ where: { userId: account.userId } }),
      account.client.user.deleteMany({ where: { id: account.userId } }),
    ]);
  } finally {
    await account.client.$disconnect();
  }
}

export function createDependencies(account: TestAccount, events: CapturedEvent[]): GenerationDependencies {
  return {
    store: createPrismaPlanStore(account.client),
    generate: generateMockSchedule,
    newRequestId: randomUUID,
    log: (event) => {
      events.push(event);
    },
  };
}

/** 捕获模拟接口与编排层通过 console.info 输出的事件，用于统计真实调用次数。 */
export function captureEvents(): { events: CapturedEvent[]; restore: () => void } {
  const events: CapturedEvent[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((message: unknown) => {
    if (typeof message !== "string") return;
    try {
      const parsed = JSON.parse(message) as CapturedEvent;
      if (typeof parsed?.event === "string") events.push(parsed);
    } catch {
      // 忽略非 JSON 的诊断输出。
    }
  });
  return { events, restore: () => spy.mockRestore() };
}

export async function withTestAccount(
  credits: number,
  descriptions: string[],
  run: (fixture: TestFixture) => Promise<void>,
): Promise<void> {
  const account = await createTestAccount(credits, descriptions);
  const captured = captureEvents();
  try {
    const events = captured.events;
    await run({ ...account, deps: createDependencies(account, events), events });
  } finally {
    captured.restore();
    await deleteTestAccount(account);
  }
}

export function startedCalls(events: CapturedEvent[]): CapturedEvent[] {
  return events.filter((event) => event.event === "mock-ai.started");
}

export function eventNames(events: CapturedEvent[]): string[] {
  return events.map((event) => event.event);
}
