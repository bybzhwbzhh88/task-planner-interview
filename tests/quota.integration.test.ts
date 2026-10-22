import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateWithQuota, type QuotaEvent } from "../src/demo-ai-app/quota";
import { createQuotaStore } from "../src/demo-ai-app/quotaStore";
import { generateMockSchedule } from "../src/demo-ai-app/mockAi";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test")) {
  throw new Error("Set QUOTA_TEST_DATABASE_URL to a dedicated PostgreSQL database whose name ends in _test; see docs/VERIFICATION.md.");
}
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const store = createQuotaStore(db);
const ids: string[] = [];
const tasks = [{ description: "Prepare interview", time: "1" }];
const noLog = () => {};
async function user(credits: number) {
  const row = await db.user.create({ data: { credits } });
  ids.push(row.id);
  return row.id;
}
async function state(id: string) {
  return {
    credits: (await db.user.findUniqueOrThrow({ where: { id } })).credits,
    results: await db.planResult.count({ where: { userId: id } }),
  };
}
function providerEvents(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.filter(([line]) => typeof line === "string" && line.includes('"event":"mock-ai.started"')).length;
}
beforeAll(async () => { await db.$connect(); });
afterAll(async () => {
  try {
    await db.$transaction([
      db.planResult.deleteMany({ where: { userId: { in: ids } } }),
      db.user.deleteMany({ where: { id: { in: ids } } }),
    ]);
  } finally { await db.$disconnect(); }
});

describe("real PostgreSQL admission and persistence", () => {
  it.each([1, 3])("AC04/05: %i credits, ten simultaneous requests, ten rounds", async (credits) => {
    for (let round = 0; round < 10; round++) {
      const id = await user(credits);
      let attempts = 0;
      let releaseModels!: () => void;
      let allReserved!: () => void;
      const modelGate = new Promise<void>(resolve => { releaseModels = resolve; });
      const admissionGate = new Promise<void>(resolve => { allReserved = resolve; });
      const observedBalances: number[] = [];
      const gatedStore = {
        ...store,
        async reserve(userId: string) {
          const admitted = await store.reserve(userId);
          observedBalances.push((await state(id)).credits);
          if (++attempts === 10) allReserved();
          return admitted;
        },
      };
      const spy = vi.spyOn(console, "info").mockImplementation(noLog);
      try {
        const pending = Array.from({ length: 10 }, () => generateWithQuota({
          userId: id, store: gatedStore, log: noLog,
          generate: async () => {
            const result = await generateMockSchedule(tasks, 8);
            await modelGate;
            return result;
          },
        }));
        // Attach rejection handlers immediately; a 402 is an expected result.
        const settled = Promise.allSettled(pending);
        try {
          await admissionGate;
          expect((await state(id)).credits).toBe(0);
          expect(observedBalances.every(balance => balance >= 0)).toBe(true);
        } finally { releaseModels(); }
        const outcomes = await settled;
        expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(credits);
        for (const result of outcomes.filter(r => r.status === "rejected")) {
          expect(result.reason).toMatchObject({ code: "NO_CREDITS", statusCode: 402 });
        }
        expect(providerEvents(spy)).toBe(credits);
        expect(await state(id)).toEqual({ credits: 0, results: credits });
      } finally { releaseModels(); spy.mockRestore(); }
    }
  });

  it("AC02: zero credits causes no provider call", async () => {
    const id = await user(0);
    const generate = vi.fn(() => generateMockSchedule(tasks, 8));
    await expect(generateWithQuota({ userId: id, store, generate, log: noLog })).rejects.toMatchObject({ statusCode: 402 });
    expect(generate).not.toHaveBeenCalled();
    expect(await state(id)).toEqual({ credits: 0, results: 0 });
  });

  it("AC03/06: actual mock failure releases the credit, then success consumes it", async () => {
    const id = await user(1);
    await expect(generateWithQuota({ userId: id, store, log: noLog,
      generate: () => generateMockSchedule([{ description: "[fail]", time: "1" }], 8),
    })).rejects.toMatchObject({ code: "MODEL_FAILED" });
    expect(await state(id)).toEqual({ credits: 1, results: 0 });
    await generateWithQuota({ userId: id, store, log: noLog, generate: () => generateMockSchedule(tasks, 8) });
    expect(await state(id)).toEqual({ credits: 0, results: 1 });
  });

  it("AC10: a real foreign-key rejection restores the original balance", async () => {
    const id = await user(1);
    const badStore = { ...store, saveResult: (resultId: string, _userId: string, content: string) =>
      store.saveResult(resultId, randomUUID(), content) };
    await expect(generateWithQuota({ userId: id, store: badStore, log: noLog,
      generate: async () => ({ tasks: [], taskItems: [] }),
    })).rejects.toMatchObject({ code: "SAVE_FAILED" });
    expect(await state(id)).toEqual({ credits: 1, results: 0 });
  });

  it("AC12: committed result plus lost acknowledgement must not receive a refund", async () => {
    const id = await user(1);
    const events: QuotaEvent[] = [];
    const uncertainStore = { ...store, async saveResult(resultId: string, userId: string, content: string) {
      await store.saveResult(resultId, userId, content);
      throw new Error("simulated acknowledgement loss");
    } };
    await expect(generateWithQuota({ userId: id, store: uncertainStore, log: e => events.push(e),
      generate: async () => ({ tasks: [], taskItems: [] }),
    })).rejects.toMatchObject({ code: "RESULT_UNCERTAIN" });
    expect(await state(id)).toEqual({ credits: 0, results: 1 });
    const saved = await db.planResult.findFirstOrThrow({ where: { userId: id } });
    expect(events.at(-1)).toMatchObject({ event: "quota.save-uncertain", resultId: saved.id });
  });

  it("AC11: a committed refund with lost acknowledgement is not applied twice", async () => {
    const id = await user(1);
    const release = vi.fn(async (userId: string) => {
      await store.release(userId);
      throw new Error("simulated acknowledgement loss");
    });
    await expect(generateWithQuota({ userId: id, store: { ...store, release }, log: noLog,
      generate: async () => { throw new Error("definite provider failure"); },
    })).rejects.toMatchObject({ code: "RESULT_UNCERTAIN" });
    expect(release).toHaveBeenCalledTimes(1);
    expect(await state(id)).toEqual({ credits: 1, results: 0 });
  });
});
