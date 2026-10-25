import { expect, it, vi } from "vitest";
import { generateForUser } from "../../src/demo-ai-app/planGeneration";
import { account, admin, connection, deferred, deps, state } from "./support";

async function simultaneous(credits: number, round: string) {
  const user = await account(credits);
  const clients = await Promise.all(Array.from({ length: 10 }, () => connection()));
  const gate = deferred(); let ready = 0;
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const results = await Promise.allSettled(clients.map(async client => {
      const d = deps(client); const reserve = d.store.reserve;
      d.store.reserve = async id => { if (++ready === 10) gate.resolve(); await gate.promise; return reserve(id); };
      return generateForUser(user, { hours: 8 }, d);
    }));
    const succeeded = results.filter(result => result.status === "fulfilled" && result.value.status === "succeeded").length;
    const rejected = results.filter(result => result.status === "rejected" && result.reason.code === "NO_CREDITS").length;
    const started = log.mock.calls.filter(([line]) => JSON.parse(line).event === "mock-ai.started").length;
    const final = await state(user);
    expect(succeeded).toBe(credits); expect(rejected).toBe(10 - credits); expect(started).toBe(credits);
    expect(final).toEqual({ credits: 0, results: credits });
    process.stdout.write(JSON.stringify({ case: round, connections: clients.length, succeeded, noCredits: rejected, started, ...final }) + "\n");
  } finally { log.mockRestore(); }
}
it("A04 真实 PostgreSQL，1 额度面对10个独立连接只调用一次", async () => {
  await simultaneous(1, "A04");
});
it("A05 真实 PostgreSQL，3额度并发10次，重复三轮无透支", async () => {
  for (let i = 1; i <= 3; i++) await simultaneous(3, `A05-round-${i}`);
});
it("A06 在途失败期间拒绝额外调用，返还后可主动重试", async () => {
  const user = await account(1, "[fail]"); const d = deps(await connection());
  const entered = deferred(), release = deferred(); const provider = d.generate;
  d.generate = async (...args) => { entered.resolve(); try { return await provider(...args); } finally { await release.promise; } };
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const first = generateForUser(user, { hours: 8 }, d);
    await entered.promise;
    expect(await state(user)).toEqual({ credits: 0, results: 0 });
    const clients = await Promise.all(Array.from({ length: 9 }, () => connection()));
    let rest;
    try { rest = await Promise.allSettled(clients.map(client => generateForUser(user, { hours: 8 }, deps(client)))); }
    finally { release.resolve(); }
    expect(rest.every(result => result.status === "rejected" && result.reason.code === "NO_CREDITS")).toBe(true);
    expect(await first).toMatchObject({ code: "MODEL_FAILED_REFUNDED" });
    expect(await state(user)).toEqual({ credits: 1, results: 0 });
    await admin.task.updateMany({ where: { userId: user }, data: { description: "正常任务" } });
    expect(await generateForUser(user, { hours: 8 }, deps(await connection()))).toMatchObject({ status: "succeeded" });
    expect(await state(user)).toEqual({ credits: 0, results: 1 });
    const started = log.mock.calls.filter(([line]) => JSON.parse(line).event === "mock-ai.started").length;
    expect(started).toBe(2);
    process.stdout.write(JSON.stringify({ case: "A06", inFlightRejected: 9, refundedCredits: 1, retrySucceeded: 1, started, finalCredits: 0 }) + "\n");
  } finally { release.resolve(); log.mockRestore(); }
});
