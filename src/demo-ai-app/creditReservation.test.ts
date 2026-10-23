import { describe, expect, it, vi } from "vitest";
import {
  CreditRefundError,
  CreditReservationError,
  executeWithReservedCredit,
  OutOfCreditsError,
  reserveCredit,
} from "./creditReservation";

class MemoryCredits {
  constructor(public value: number) {}

  async reserve(): Promise<boolean> {
    await Promise.resolve();
    if (this.value <= 0) return false;
    this.value -= 1;
    return true;
  }

  async refund(): Promise<void> {
    this.value += 1;
  }
}

describe("reserveCredit", () => {
  it("uses a conditional atomic decrement", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    await expect(reserveCredit("user-1", updateMany)).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", credits: { gt: 0 } },
      data: { credits: { decrement: 1 } },
    });
  });
});

describe("executeWithReservedCredit", () => {
  it("persists a successful result and keeps the charge", async () => {
    const credits = new MemoryCredits(3);
    const persist = vi.fn().mockResolvedValue(undefined);

    await expect(
      executeWithReservedCredit({
        reserve: () => credits.reserve(),
        generate: async () => "schedule",
        persist,
        refund: () => credits.refund(),
      }),
    ).resolves.toBe("schedule");

    expect(persist).toHaveBeenCalledWith("schedule");
    expect(credits.value).toBe(2);
  });

  it("does not call the provider or persist when no credit is available", async () => {
    const credits = new MemoryCredits(0);
    const generate = vi.fn().mockResolvedValue("schedule");
    const persist = vi.fn().mockResolvedValue(undefined);

    await expect(
      executeWithReservedCredit({
        reserve: () => credits.reserve(),
        generate,
        persist,
        refund: () => credits.refund(),
      }),
    ).rejects.toBeInstanceOf(OutOfCreditsError);

    expect(generate).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(credits.value).toBe(0);
  });

  it("does not refund or generate when reserving fails", async () => {
    const generate = vi.fn().mockResolvedValue("schedule");
    const refund = vi.fn().mockResolvedValue(undefined);

    await expect(
      executeWithReservedCredit({
        reserve: async () => {
          throw new Error("database unavailable");
        },
        generate,
        persist: vi.fn(),
        refund,
      }),
    ).rejects.toBeInstanceOf(CreditReservationError);

    expect(generate).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
  });

  it("refunds the credit when generation fails", async () => {
    const credits = new MemoryCredits(1);
    const providerError = new Error("provider failed");

    await expect(
      executeWithReservedCredit({
        reserve: () => credits.reserve(),
        generate: async () => {
          throw providerError;
        },
        persist: vi.fn(),
        refund: () => credits.refund(),
      }),
    ).rejects.toBe(providerError);

    expect(credits.value).toBe(1);
  });

  it("refunds the credit when saving the result fails", async () => {
    const credits = new MemoryCredits(1);
    const persistenceError = new Error("database write failed");

    await expect(
      executeWithReservedCredit({
        reserve: () => credits.reserve(),
        generate: async () => "schedule",
        persist: async () => {
          throw persistenceError;
        },
        refund: () => credits.refund(),
      }),
    ).rejects.toBe(persistenceError);

    expect(credits.value).toBe(1);
  });

  it("reports an uncertain balance when refunding fails", async () => {
    const providerError = new Error("provider failed");
    const refundError = new Error("refund failed");

    await expect(
      executeWithReservedCredit({
        reserve: async () => true,
        generate: async () => {
          throw providerError;
        },
        persist: vi.fn(),
        refund: async () => {
          throw refundError;
        },
      }),
    ).rejects.toMatchObject<Partial<CreditRefundError>>({
      name: "CreditRefundError",
      operationError: providerError,
      refundError,
    });
  });

  it("allows only one provider call when five requests share one credit", async () => {
    const credits = new MemoryCredits(1);
    const generate = vi.fn(async () => "schedule");
    const persist = vi.fn().mockResolvedValue(undefined);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        executeWithReservedCredit({
          reserve: () => credits.reserve(),
          generate,
          persist,
          refund: () => credits.refund(),
        }),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(4);
    expect(
      rejected.every((result) => result.reason instanceof OutOfCreditsError),
    ).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(credits.value).toBe(0);
  });
});
