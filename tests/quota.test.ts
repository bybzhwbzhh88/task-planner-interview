import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createQuotaStore, generatePlanWithQuota, ProviderRejectedError, SaveRejectedError, type QuotaStore } from "../src/demo-ai-app/quota";
import { generateMockSchedule } from "../src/demo-ai-app/mockAi";

const rawUrl = process.env.TEST_DATABASE_URL;
if (!rawUrl || !/^\/[a-zA-Z0-9_]+_test$/.test(new URL(rawUrl).pathname)) {
  throw new Error("Set TEST_DATABASE_URL to a migrated PostgreSQL database ending in _test");
}
const testUrl = new URL(rawUrl);
testUrl.searchParams.set("connection_limit", "10");
testUrl.searchParams.set("pool_timeout", "30");
function testDatabase() { return new PrismaClient({ datasourceUrl: testUrl.toString() }); }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const fixtureSchedule = { tasks: [{ name: "read", priority: "medium" as const }], taskItems: [] };
function fixture() {
  const store: QuotaStore = {
    loadTasks: vi.fn(async () => [{ description: "read", time: "1" }]),
    reserve: vi.fn(async () => true), refund: vi.fn(async () => {}), save: vi.fn(async () => {}),
  };
  const provider = vi.fn(async () => fixtureSchedule);
  return { store, provider, run: (args: unknown = { hours: 8 }, user: { id: string } | undefined = { id: "alice" }) => generatePlanWithQuota(args, user, { store, provider }) };
}

describe("quota orchestration and failure semantics", () => {
  it("rejects unauthenticated requests before any database access", async () => {
    const f = fixture();
    await expect(generatePlanWithQuota({ hours: 8 }, undefined, f)).rejects.toMatchObject({ statusCode: 401 });
    expect(f.store.loadTasks).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, "8", null, undefined])("rejects invalid hours %s before reserving", async (hours) => {
    const f = fixture();
    await expect(f.run({ hours })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(f.store.reserve).not.toHaveBeenCalled();
    expect(f.provider).not.toHaveBeenCalled();
  });
  it.each([0, 0.5, 25])("accepts numeric hours %s without a range restriction", async (hours) => {
    const f = fixture(); await expect(f.run({ hours })).resolves.toEqual(fixtureSchedule);
  });
  it("rejects an empty task list before debit and provider", async () => {
    const f = fixture(); vi.mocked(f.store.loadTasks).mockResolvedValue([]);
    await expect(f.run()).rejects.toMatchObject({ code: "NO_TASKS" });
    expect(f.store.reserve).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
  });
  it("a task read failure makes no debit", async () => {
    const f = fixture(); vi.mocked(f.store.loadTasks).mockRejectedValue(new Error("offline"));
    await expect(f.run()).rejects.toMatchObject({ code: "TASKS_UNAVAILABLE" });
    expect(f.store.reserve).not.toHaveBeenCalled();
  });
  it("runs reserve -> provider -> save in that order", async () => {
    const f = fixture(); const order: string[] = [];
    vi.mocked(f.store.reserve).mockImplementation(async () => { order.push("reserve"); return true; });
    f.provider.mockImplementation(async () => { order.push("provider"); return fixtureSchedule; });
    vi.mocked(f.store.save).mockImplementation(async () => { order.push("save"); });
    await f.run(); expect(order).toEqual(["reserve", "provider", "save"]);
    expect(f.store.refund).not.toHaveBeenCalled();
  });
  it("insufficient credit never calls the provider", async () => {
    const f = fixture(); vi.mocked(f.store.reserve).mockResolvedValue(false);
    await expect(f.run()).rejects.toMatchObject({ statusCode: 402 });
    expect(f.provider).not.toHaveBeenCalled(); expect(f.store.refund).not.toHaveBeenCalled();
  });
  it("an ambiguous debit is never retried or blindly refunded", async () => {
    const f = fixture(); vi.mocked(f.store.reserve).mockRejectedValue(new Error("lost debit reply"));
    await expect(f.run()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(f.store.reserve).toHaveBeenCalledTimes(1); expect(f.store.refund).not.toHaveBeenCalled();
    expect(f.provider).not.toHaveBeenCalled();
  });
  it.each(["provider", "save"] as const)("refunds explicit %s rejection exactly once", async (phase) => {
    const f = fixture();
    if (phase === "provider") f.provider.mockRejectedValue(new ProviderRejectedError("rejected"));
    else vi.mocked(f.store.save).mockRejectedValue(new SaveRejectedError("rejected"));
    await expect(f.run()).rejects.toMatchObject({ statusCode: 502 });
    expect(f.store.refund).toHaveBeenCalledTimes(1);
  });
  it.each(["provider", "save"] as const)("does not refund an unknown %s outcome", async (phase) => {
    const f = fixture();
    if (phase === "provider") f.provider.mockRejectedValue(new Error("timeout"));
    else vi.mocked(f.store.save).mockRejectedValue(new Error("lost commit reply"));
    await expect(f.run()).rejects.toMatchObject({ statusCode: 503, code: "OUTCOME_UNKNOWN" });
    expect(f.store.refund).not.toHaveBeenCalled();
  });
  it("refund failure does not promise a refund and is not retried", async () => {
    const f = fixture(); f.provider.mockRejectedValue(new ProviderRejectedError("rejected"));
    vi.mocked(f.store.refund).mockRejectedValue(new Error("offline"));
    await expect(f.run()).rejects.toMatchObject({ code: "REFUND_UNKNOWN" });
    expect(f.store.refund).toHaveBeenCalledTimes(1);
  });
});

const db = testDatabase();
const ids: string[] = [];
const store = createQuotaStore(db);
const schedule = { tasks: [{ name: "fixture", priority: "medium" as const }], taskItems: [] };
const logged: { event: string; callId?: string }[] = [];
let consoleSpy: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  await db.$connect();
  consoleSpy = vi.spyOn(console, "info").mockImplementation((line) => {
    try { logged.push(JSON.parse(String(line))); } catch { /* ignore non-provider output */ }
  });
});
afterAll(async () => {
  consoleSpy?.mockRestore();
  await db.planResult.deleteMany({ where: { userId: { in: ids } } });
  await db.task.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});
async function account(credits: number, description = "read") {
  const user = await db.user.create({ data: { credits } }); ids.push(user.id);
  await db.task.create({ data: { userId: user.id, description } }); return user;
}
async function balance(id: string) { return (await db.user.findUniqueOrThrow({ where: { id } })).credits; }
async function resultCount(id: string) { return db.planResult.count({ where: { userId: id } }); }
function run(user: { id: string }, selectedStore = store, provider = generateMockSchedule) {
  return generatePlanWithQuota({ hours: 8 }, user, { store: selectedStore, provider });
}
function startedSince(index: number) { return logged.slice(index).filter((event) => event.event === "mock-ai.started"); }

describe("real PostgreSQL quota", () => {
  it("AC01 success debits once, saves once and logs one provider call", async () => {
    const user = await account(3); const start = logged.length;
    await run(user);
    expect(await balance(user.id)).toBe(2); expect(await resultCount(user.id)).toBe(1);
    expect(startedSince(start)).toHaveLength(1);
    expect(logged.slice(start).find((event) => event.event === "mock-ai.succeeded")?.callId).toBe(startedSince(start)[0].callId);
  });
  it("AC02 zero credit ignores a stale authentication balance of 999", async () => {
    const user = await account(0); const stale = { ...user, credits: 999 }; const start = logged.length;
    await expect(run(stale)).rejects.toMatchObject({ statusCode: 402 });
    expect(startedSince(start)).toHaveLength(0); expect(await balance(user.id)).toBe(0); expect(await resultCount(user.id)).toBe(0);
  });
  it("AC03 explicit provider failure refunds; fixing the task permits retry", async () => {
    const user = await account(1, "read [fail]"); const start = logged.length;
    await expect(run(user)).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
    expect(await balance(user.id)).toBe(1); expect(await resultCount(user.id)).toBe(0);
    expect(logged.slice(start).find((event) => event.event === "mock-ai.failed")?.callId).toBe(startedSince(start)[0].callId);
    await db.task.updateMany({ where: { userId: user.id }, data: { description: "fixed" } });
    await run(user); expect(await balance(user.id)).toBe(0); expect(await resultCount(user.id)).toBe(1);
  });
  it.each([1, 3])("AC04/05 credit=%i, 10 concurrent requests: exact calls, saves and rejections", async (credits) => {
    for (let round = 0; round < 3; round++) {
      const user = await account(credits); const start = logged.length;
      const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => run(user)));
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(credits);
      for (const outcome of outcomes) if (outcome.status === "rejected") expect(outcome.reason).toMatchObject({ statusCode: 402 });
      expect(await balance(user.id)).toBe(0); expect(await resultCount(user.id)).toBe(credits);
      expect(startedSince(start)).toHaveLength(credits);
    }
  });
  it("AC06 concurrently failing requests restore the starting balance without over-refunding", async () => {
    const user = await account(3, "[fail]"); const start = logged.length;
    const outcomes = await Promise.allSettled(Array.from({ length: 50 }, () => run(user)));
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect([402, 502]).toContain(outcome.reason.statusCode);
    }
    expect(await balance(user.id)).toBe(3); expect(await resultCount(user.id)).toBe(0);
    expect(startedSince(start).length).toBeGreaterThan(0);
    expect(logged.slice(start).filter((event) => event.event === "mock-ai.failed")).toHaveLength(startedSince(start).length);
  });
  it("AC07 gates the last credit: competitors reject, failure releases, a later request succeeds", async () => {
    const user = await account(1); const entered = deferred(); const release = deferred();
    const slowFailure = run(user, store, async () => { entered.resolve(); await release.promise; throw new ProviderRejectedError("controlled failure"); });
    // Attach a rejection observer before deliberately releasing the provider.
    const first = slowFailure.catch((error: unknown) => error);
    try {
      await entered.promise;
      await expect(run(user)).rejects.toMatchObject({ statusCode: 402 });
      expect(await balance(user.id)).toBe(0);
    } finally { release.resolve(); }
    expect(await first).toMatchObject({ code: "PROVIDER_FAILED" });
    expect(await balance(user.id)).toBe(1);
    await run(user); expect(await balance(user.id)).toBe(0); expect(await resultCount(user.id)).toBe(1);
  });
  it("AC08 slow provider holds no transaction lock and another account can complete", async () => {
    const a = await account(1); const b = await account(1); const entered = deferred(); const release = deferred();
    const pending = run(a, store, async () => { entered.resolve(); await release.promise; return schedule; });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered.promise;
      // Same user's harmless update would block if a model-spanning row lock existed.
      await Promise.race([
        db.user.update({ where: { id: a.id }, data: { credits: { increment: 0 } } }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("user row remained locked")), 2_000); }),
      ]);
      await run(b); expect(await resultCount(b.id)).toBe(1); expect(await resultCount(a.id)).toBe(0);
    } finally { clearTimeout(timeout); release.resolve(); await pending; }
  });
  it("AC09 mixed accounts keep balances, tasks and results isolated", async () => {
    const users = await Promise.all([0, 1, 3].map((credits) => account(credits, `owner-${credits}`)));
    await Promise.all(users.map(async (user) => {
      const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => run(user)));
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(user.credits);
      expect(await balance(user.id)).toBe(0);
      const saved = await db.planResult.findMany({ where: { userId: user.id } });
      expect(saved).toHaveLength(user.credits);
      for (const result of saved) expect(JSON.parse(result.content).tasks[0].name).toBe(`owner-${user.credits}`);
    }));
  });
  it("AC10 a real INSERT foreign-key rejection refunds the reservation", async () => {
    const user = await account(1);
    const broken: QuotaStore = { ...store, save: (_id, value) => store.save(`missing-${randomUUID()}`, value) };
    await expect(run(user, broken)).rejects.toMatchObject({ code: "SAVE_FAILED" });
    expect(await balance(user.id)).toBe(1); expect(await resultCount(user.id)).toBe(0);
  });
  it("AC11 a lost reply after a committed save does not refund a free plan", async () => {
    const user = await account(1);
    const lost: QuotaStore = { ...store, async save(id, value) { await store.save(id, value); throw new Error("commit reply lost"); } };
    await expect(run(user, lost)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(await balance(user.id)).toBe(0); expect(await resultCount(user.id)).toBe(1);
  });
  it.each([false, true])("AC12 refund failure, already committed=%s, never retries the increment", async (committed) => {
    const user = await account(1, "[fail]"); let refunds = 0;
    const broken: QuotaStore = { ...store, async refund(id) { refunds++; if (committed) await store.refund(id); throw new Error("refund reply missing"); } };
    await expect(run(user, broken)).rejects.toMatchObject({ code: "REFUND_UNKNOWN" });
    expect(refunds).toBe(1); expect(await balance(user.id)).toBe(committed ? 1 : 0); expect(await resultCount(user.id)).toBe(0);
  });
  it("AC13 a lost debit reply does not call the provider or invent a refund", async () => {
    const user = await account(1); const start = logged.length;
    const lost: QuotaStore = { ...store, async reserve(id) { await store.reserve(id); throw new Error("debit reply lost"); } };
    await expect(run(user, lost)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(await balance(user.id)).toBe(0); expect(startedSince(start)).toHaveLength(0);
  });
  it("AC14 a response lost after successful generation does not make an intentional retry free", async () => {
    const user = await account(2); const start = logged.length;
    await run(user); // The transport discards this successful response.
    await run(user); // An intentional retry is a new billable generation.
    expect(await balance(user.id)).toBe(0); expect(await resultCount(user.id)).toBe(2); expect(startedSince(start)).toHaveLength(2);
  });
});

describe("分级并发：余额、模型日志和保存结果", () => {
  for (const profile of ["争抢", "成功", "失败"] as const) {
    for (const requests of [10, 50, 100, 500, 1000]) {
      for (let round = 1; round <= 3; round++) {
        it(`${profile} / ${requests} 请求 / 第 ${round} 轮`, async () => {
          const credits = profile === "争抢" ? 3 : requests;
          const successes = profile === "失败" ? 0 : credits;
          const user = await account(credits, profile === "失败" ? "[fail]" : "read");
          const index = logged.length;
          const started = performance.now();
          const outcomes = await Promise.allSettled(Array.from({ length: requests }, () => run(user)));
          expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(successes);
          const rejected = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason.code] : []);
          expect(rejected.filter((code) => code === "NO_CREDITS")).toHaveLength(requests - credits);
          expect(rejected.filter((code) => code === "PROVIDER_FAILED")).toHaveLength(profile === "失败" ? requests : 0);
          expect(await balance(user.id)).toBe(credits - successes);
          expect(await resultCount(user.id)).toBe(successes);
          const calls = startedSince(index);
          expect(calls).toHaveLength(credits);
          expect(new Set(calls.map((call) => call.callId)).size).toBe(credits);
          expect(logged.slice(index).filter((event) => event.event === "mock-ai.succeeded")).toHaveLength(successes);
          expect(logged.slice(index).filter((event) => event.event === "mock-ai.failed")).toHaveLength(credits - successes);
          console.log(`${profile}, requests=${requests}, round=${round}, calls=${calls.length}, saved=${successes}, balance=${credits - successes}, ms=${Math.round(performance.now() - started)}`);
        });
      }
    }
  }
});
