import { describe, expect, it, vi } from "vitest";
import type { GeneratedSchedule } from "../src/demo-ai-app/schedule";
import {
  generateScheduleWithQuota,
  QuotaGenerationError,
  type QuotaGenerationLogger,
  type QuotaGenerationStore,
} from "../src/demo-ai-app/quotaGeneration";

const schedule: GeneratedSchedule = {
  tasks: [{ name: "Write report", priority: "medium" }],
  taskItems: [
    {
      description: "Draft: Write report",
      taskName: "Write report",
      time: 1,
    },
  ],
};

class FakeStore implements QuotaGenerationStore {
  reserveCalls = 0;
  refundCalls = 0;
  saveCalls = 0;
  failSave = false;
  failRefund = false;

  constructor(public credits: number) {}

  async reserveCredit(): Promise<boolean> {
    this.reserveCalls += 1;
    if (this.credits <= 0) {
      return false;
    }
    this.credits -= 1;
    return true;
  }

  async refundCredit(): Promise<number> {
    this.refundCalls += 1;
    if (this.failRefund) {
      throw new Error("refund unavailable");
    }
    this.credits += 1;
    return this.credits;
  }

  async saveResultAndGetBalance(): Promise<number> {
    this.saveCalls += 1;
    if (this.failSave) {
      throw new Error("database write failed");
    }
    return this.credits;
  }
}

function makeLogger(): QuotaGenerationLogger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    error: vi.fn(),
  };
}

const tasks = [{ description: "Write report", time: "3" }];

describe("generateScheduleWithQuota", () => {
  it("reserves one credit and returns the saved balance on success", async () => {
    const store = new FakeStore(3);
    const provider = vi.fn().mockResolvedValue(schedule);

    const result = await generateScheduleWithQuota({
      userId: "user-1",
      tasks,
      hours: 8,
      store,
      generateSchedule: provider,
      logger: makeLogger(),
    });

    expect(result).toEqual({ schedule, creditsRemaining: 2 });
    expect(store.reserveCalls).toBe(1);
    expect(store.saveCalls).toBe(1);
    expect(store.refundCalls).toBe(0);
    expect(provider).toHaveBeenCalledOnce();
  });

  it("does not call the provider when no credit can be reserved", async () => {
    const store = new FakeStore(0);
    const provider = vi.fn().mockResolvedValue(schedule);

    await expect(
      generateScheduleWithQuota({
        userId: "user-2",
        tasks,
        hours: 8,
        store,
        generateSchedule: provider,
        logger: makeLogger(),
      }),
    ).rejects.toMatchObject<QuotaGenerationError>({
      kind: "insufficient-credits",
    });

    expect(provider).not.toHaveBeenCalled();
    expect(store.refundCalls).toBe(0);
    expect(store.saveCalls).toBe(0);
  });

  it("refunds exactly once when the provider fails", async () => {
    const store = new FakeStore(2);
    const provider = vi.fn().mockRejectedValue(new Error("provider failed"));

    await expect(
      generateScheduleWithQuota({
        userId: "user-3",
        tasks,
        hours: 8,
        store,
        generateSchedule: provider,
        logger: makeLogger(),
      }),
    ).rejects.toMatchObject<QuotaGenerationError>({
      kind: "provider-failed",
    });

    expect(store.credits).toBe(2);
    expect(store.refundCalls).toBe(1);
    expect(store.saveCalls).toBe(0);
  });

  it("refunds exactly once when result persistence fails", async () => {
    const store = new FakeStore(2);
    store.failSave = true;
    const provider = vi.fn().mockResolvedValue(schedule);

    await expect(
      generateScheduleWithQuota({
        userId: "user-4",
        tasks,
        hours: 8,
        store,
        generateSchedule: provider,
        logger: makeLogger(),
      }),
    ).rejects.toMatchObject<QuotaGenerationError>({
      kind: "persistence-failed",
    });

    expect(store.credits).toBe(2);
    expect(store.refundCalls).toBe(1);
    expect(store.saveCalls).toBe(1);
  });

  it("reports a refund failure without retrying the increment", async () => {
    const store = new FakeStore(1);
    store.failRefund = true;
    const provider = vi.fn().mockRejectedValue(new Error("provider failed"));
    const logger = makeLogger();

    await expect(
      generateScheduleWithQuota({
        userId: "user-5",
        tasks,
        hours: 8,
        store,
        generateSchedule: provider,
        logger,
      }),
    ).rejects.toMatchObject<QuotaGenerationError>({
      kind: "refund-failed",
    });

    expect(store.refundCalls).toBe(1);
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
