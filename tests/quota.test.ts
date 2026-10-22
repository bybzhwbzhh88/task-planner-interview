import { describe, expect, it, vi } from "vitest";
import { generateWithQuota, QuotaError, type QuotaStore } from "../src/demo-ai-app/quota";

const schedule = { tasks: [], taskItems: [] };

function fixture(credits = 1) {
  const state = { credits, results: [] as string[] };
  const store: QuotaStore = {
    reserve: vi.fn(async () => {
      if (!state.credits) return false;
      state.credits--;
      return true;
    }),
    release: vi.fn(async () => { state.credits++; }),
    saveResult: vi.fn(async (id) => { state.results.push(id); }),
    isDefiniteSaveFailure: () => false,
  };
  const generate = vi.fn(async () => schedule);
  const run = () => generateWithQuota({ userId: "test-user", store, generate, log: () => {} });
  return { state, store, generate, run };
}

describe("quota lifecycle", () => {
  it("AC01: consumes exactly one credit for a saved result", async () => {
    const f = fixture(3);
    await expect(f.run()).resolves.toEqual(schedule);
    expect(f.state.credits).toBe(2);
    expect(f.state.results).toHaveLength(1);
    expect(f.store.release).not.toHaveBeenCalled();
  });

  it("AC02: rejects before calling the provider when there is no credit", async () => {
    const f = fixture(0);
    await expect(f.run()).rejects.toMatchObject({ statusCode: 402, code: "NO_CREDITS" });
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.store.saveResult).not.toHaveBeenCalled();
    expect(f.store.release).not.toHaveBeenCalled();
  });

  it("AC03/06: releases a failed generation and permits a later success", async () => {
    const f = fixture();
    f.generate.mockRejectedValueOnce(new Error("explicit fixture failure"));
    await expect(f.run()).rejects.toMatchObject({ statusCode: 502, code: "MODEL_FAILED" });
    expect(f.state.credits).toBe(1);
    expect(f.state.results).toHaveLength(0);
    await f.run();
    expect(f.state.credits).toBe(0);
    expect(f.state.results).toHaveLength(1);
    expect(f.store.release).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid model output without consuming credit", async () => {
    const f = fixture();
    f.generate.mockResolvedValueOnce(null as never);
    await expect(f.run()).rejects.toBeInstanceOf(QuotaError);
    expect(f.state.credits).toBe(1);
    expect(f.store.saveResult).not.toHaveBeenCalled();
  });

  it("AC10: releases after a definite save rejection", async () => {
    const f = fixture();
    vi.mocked(f.store.saveResult).mockRejectedValueOnce(new Error("statement rejected"));
    f.store.isDefiniteSaveFailure = () => true;
    await expect(f.run()).rejects.toMatchObject({ code: "SAVE_FAILED" });
    expect(f.state.credits).toBe(1);
    expect(f.state.results).toHaveLength(0);
  });

  it.each([false, true])("AC12: does not refund an uncertain save (committed=%s)", async (committed) => {
    const f = fixture();
    f.store.saveResult = vi.fn(async (id) => {
      if (committed) f.state.results.push(id);
      throw new Error("connection lost");
    });
    await expect(f.run()).rejects.toMatchObject({ code: "RESULT_UNCERTAIN" });
    expect(f.state.credits).toBe(0);
    expect(f.store.release).not.toHaveBeenCalled();
    expect(f.state.results).toHaveLength(committed ? 1 : 0);
  });

  it.each([false, true])("AC11: does not retry an uncertain refund (committed=%s)", async (committed) => {
    const f = fixture();
    f.generate.mockRejectedValueOnce(new Error("provider failed"));
    f.store.release = vi.fn(async () => {
      if (committed) f.state.credits++;
      throw new Error("refund acknowledgement lost");
    });
    await expect(f.run()).rejects.toMatchObject({ code: "RESULT_UNCERTAIN" });
    expect(f.store.release).toHaveBeenCalledTimes(1);
    expect(f.state.credits).toBe(committed ? 1 : 0);
  });

  it("does not call the model or refund when reservation outcome is unknown", async () => {
    const f = fixture();
    vi.mocked(f.store.reserve).mockRejectedValueOnce(new Error("connection lost"));
    await expect(f.run()).rejects.toMatchObject({ code: "RESULT_UNCERTAIN" });
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.store.release).not.toHaveBeenCalled();
  });
});
