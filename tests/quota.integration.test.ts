import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { generatePlanForUser } from "../src/demo-ai-app/planService";
import { createQuotaService, type QuotaHooks } from "../src/demo-ai-app/quotaService";
import { generateMockSchedule } from "../src/demo-ai-app/mockAi";
import { PlanError } from "../src/demo-ai-app/planError";

if (!process.env.TEST_DATABASE_URL) process.loadEnvFile(".env.quota-test");
const url = process.env.TEST_DATABASE_URL;
if (!url || !/^[a-z][a-z0-9_]*_quota_test$/.test(new URL(url).pathname.slice(1))) {
  throw new Error("Explicit isolated TEST_DATABASE_URL ending _quota_test required");
}
const db = new PrismaClient({ datasources: { db: { url } } });
const ids: string[] = [];
let events: { event: string; callId: string }[] = [];
const observations: unknown[] = [];
let consoleSpy: ReturnType<typeof vi.spyOn>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function heldModel(count = 1) {
  const entered = deferred();
  const gate = deferred();
  let calls = 0;
  const model: typeof generateMockSchedule = async (tasks, hours) => {
    const outcome = generateMockSchedule(tasks, hours).then(
      (value) => ({ value }), (error: unknown) => ({ error }),
    );
    if (++calls === count) entered.resolve();
    await gate.promise;
    const settled = await outcome;
    if ("error" in settled) throw settled.error;
    return settled.value;
  };
  return { model, entered: entered.promise, release: gate.resolve };
}

async function fixture(credits = 1, description = "ordinary task") {
  const user = await db.user.create({ data: { credits } });
  ids.push(user.id);
  await db.task.create({ data: { userId: user.id, description } });
  return user;
}

async function snapshot(userId: string) {
  return {
    C: (await db.user.findUniqueOrThrow({ where: { id: userId } })).credits,
    P: await db.generationAttempt.count({ where: { userId, status: "RESERVED" } }),
    R: await db.planResult.count({ where: { userId } }),
  };
}
const modelCounts = () => ({
  M: events.filter((entry) => entry.event === "mock-ai.started").length,
  succeeded: events.filter((entry) => entry.event === "mock-ai.succeeded").length,
  failed: events.filter((entry) => entry.event === "mock-ai.failed").length,
});

async function request(user: { id: string; credits?: number } | undefined, options: {
  hooks?: QuotaHooks; model?: typeof generateMockSchedule; args?: unknown;
} = {}) {
  try {
    const schedule = await generatePlanForUser(options.args ?? { hours: 8 }, user, {
      db, quota: createQuotaService(db, options.hooks), model: options.model,
    });
    return { status: 200, schedule, code: undefined };
  } catch (error) {
    if (!(error instanceof PlanError)) throw error;
    return { status: error.statusCode, code: error.code, attemptId: error.attemptId };
  }
}

async function check(label: string, userId: string, expected: { C: number; P: number; R: number; M: number }) {
  const actual = { ...await snapshot(userId), ...modelCounts() };
  observations.push({ label, expected, actual });
  expect(actual, label).toMatchObject(expected);
  const attempts = await db.generationAttempt.findMany({ where: { userId }, include: { result: true } });
  for (const attempt of attempts) {
    expect(!!attempt.result, label + " result/state").toBe(attempt.status === "SUCCEEDED");
    if (attempt.result) expect(attempt.result.userId).toBe(userId);
  }
}

function failOnce(phaseToFail: "reserve" | "confirm" | "release"): QuotaHooks {
  let used = false;
  return { insideTransaction: async (phase, tx) => {
    if (phase === phaseToFail && !used) {
      used = true;
      await tx.$executeRawUnsafe("SELECT 1 / 0");
    }
  } };
}

beforeAll(async () => {
  await db.$connect();
  consoleSpy = vi.spyOn(console, "info").mockImplementation((line) => {
    try { const event = JSON.parse(String(line)); if (event.callId) events.push(event); } catch { /* not a provider event */ }
  });
});
beforeEach(() => { events = []; });
afterAll(async () => {
  consoleSpy?.mockRestore();
  mkdirSync("test-results/quota", { recursive: true });
  writeFileSync("test-results/quota/service-observations.json", JSON.stringify(observations, null, 2));
  await db.planResult.deleteMany({ where: { userId: { in: ids } } });
  await db.generationAttempt.deleteMany({ where: { userId: { in: ids } } });
  await db.task.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

describe("real PostgreSQL quota protocol", () => {
  test("AC01–AC04 initial/success/last credit/zero credit", async () => {
    const user = await fixture(3);
    await check("AC01", user.id, { C: 3, P: 0, R: 0, M: 0 });
    expect((await request(user)).status).toBe(200);
    await check("AC02", user.id, { C: 2, P: 0, R: 1, M: 1 });
    await request(user);
    events = [];
    expect((await request(user)).status).toBe(200);
    await check("AC03", user.id, { C: 0, P: 0, R: 3, M: 1 });
    events = [];
    expect(await request(user)).toMatchObject({ status: 402, code: "NO_AVAILABLE_CREDIT" });
    await check("AC04", user.id, { C: 0, P: 0, R: 3, M: 0 });
  });

  test("AC05–AC06 explicit provider failure releases then recovers", async () => {
    const user = await fixture(1, "[fail]");
    expect(await request(user)).toMatchObject({ status: 502, code: "PROVIDER_FAILED" });
    await check("AC05", user.id, { C: 1, P: 0, R: 0, M: 1 });
    expect(modelCounts().failed).toBe(1);
    await db.task.updateMany({ where: { userId: user.id }, data: { description: "recovered" } });
    events = [];
    expect((await request(user)).status).toBe(200);
    await check("AC06", user.id, { C: 0, P: 0, R: 1, M: 1 });
  });

  test("AC07–AC08 simultaneous requests never overspend or overcall", async () => {
    for (const credits of [1, 3]) {
      for (let round = 0; round < 10; round++) {
        events = [];
        const user = await fixture(credits);
        const responses = await Promise.all(Array.from({ length: 5 }, () => request(user)));
        expect(responses.filter((response) => response.status === 200)).toHaveLength(credits);
        expect(responses.filter((response) => response.status === 402)).toHaveLength(5 - credits);
        await check((credits === 1 ? "AC07" : "AC08") + " round " + round, user.id, { C: 0, P: 0, R: credits, M: credits });
      }
    }
  });

  test("AC09 held failure rejects competitors and leaves quota usable", async () => {
    const user = await fixture(1, "[fail]");
    const held = heldModel();
    const first = request(user, { model: held.model });
    await held.entered;
    try {
      expect((await Promise.all([request(user), request(user)])).map((r) => r.status)).toEqual([402, 402]);
    } finally { held.release(); }
    expect((await first).status).toBe(502);
    await check("AC09 failure phase", user.id, { C: 1, P: 0, R: 0, M: 1 });
    await db.task.updateMany({ where: { userId: user.id }, data: { description: "normal" } });
    events = [];
    expect((await request(user)).status).toBe(200);
    await check("AC09 recovery", user.id, { C: 0, P: 0, R: 1, M: 1 });
  });

  test("AC10 persistence rollback does not consume and next request works", async () => {
    const user = await fixture();
    expect(await request(user, { hooks: failOnce("confirm") })).toMatchObject({ status: 500, code: "SAVE_FAILED" });
    await check("AC10 rollback", user.id, { C: 1, P: 0, R: 0, M: 1 });
    expect(modelCounts().succeeded).toBe(1);
    events = [];
    expect((await request(user)).status).toBe(200);
    await check("AC10 recovery", user.id, { C: 0, P: 0, R: 1, M: 1 });
  });

  test("AC11 different accounts enter model concurrently", async () => {
    const a = await fixture();
    const b = await fixture();
    const held = heldModel(2);
    const requests = [request(a, { model: held.model }), request(b, { model: held.model })];
    await held.entered;
    expect(modelCounts().M).toBe(2);
    held.release();
    expect((await Promise.all(requests)).map((r) => r.status)).toEqual([200, 200]);
    await check("AC11 A", a.id, { C: 0, P: 0, R: 1, M: 2 });
    await check("AC11 B", b.id, { C: 0, P: 0, R: 1, M: 2 });
  });

  test("AC12 auth/empty/range/nonfinite reject before model; valid decimals work", async () => {
    expect((await request(undefined)).status).toBe(401);
    const user = await fixture(3);
    for (const hours of [0, 25, "8", NaN, Infinity, -Infinity]) {
      expect((await request(user, { args: { hours } })).status).toBe(400);
    }
    await db.task.deleteMany({ where: { userId: user.id } });
    expect((await request(user)).status).toBe(400);
    await check("AC12 rejected", user.id, { C: 3, P: 0, R: 0, M: 0 });
    for (const hours of [1, 24, 1.25]) {
      events = [];
      const valid = await fixture(3);
      expect((await request(valid, { args: { hours } })).status).toBe(200);
      await check("AC12 valid " + hours, valid.id, { C: 2, P: 0, R: 1, M: 1 });
    }
  });

  test("AC14 auth credit snapshot is ignored in both directions", async () => {
    const empty = await fixture(0);
    expect((await request({ id: empty.id, credits: 3 })).status).toBe(402);
    await check("AC14 stale high", empty.id, { C: 0, P: 0, R: 0, M: 0 });
    const funded = await fixture(1);
    expect((await request({ id: funded.id, credits: 0 })).status).toBe(200);
    await check("AC14 stale low", funded.id, { C: 0, P: 0, R: 1, M: 1 });
  });

  test("AC15 attempt insert failure rolls back predecrement", async () => {
    const user = await fixture();
    expect(await request(user, { hooks: failOnce("reserve") })).toMatchObject({ status: 503, code: "DB_UNAVAILABLE" });
    await check("AC15 rollback", user.id, { C: 1, P: 0, R: 0, M: 0 });
    expect((await request(user)).status).toBe(200);
    await check("AC15 recovery", user.id, { C: 0, P: 0, R: 1, M: 1 });
  });

  test("AC16 repeated and concurrent releases refund only once, success cannot refund", async () => {
    const user = await fixture();
    const quota = createQuotaService(db);
    const id = randomUUID();
    await quota.reserve(user.id, id);
    const releases = await Promise.all([quota.release(user.id, id), quota.release(user.id, id)]);
    expect(releases.map((r) => r.status)).toEqual(["RELEASED", "RELEASED"]);
    expect((await quota.release(user.id, id)).status).toBe("RELEASED");
    await check("AC16 release", user.id, { C: 1, P: 0, R: 0, M: 0 });
    const success = await fixture();
    expect((await request(success)).status).toBe(200);
    const attempt = await db.generationAttempt.findFirstOrThrow({ where: { userId: success.id } });
    expect((await quota.release(success.id, attempt.id)).status).toBe("SUCCEEDED");
    await check("AC16 committed success", success.id, { C: 0, P: 0, R: 1, M: 1 });
  });

  test("AC17 lost confirm reply returns committed result, no double save/refund", async () => {
    const user = await fixture();
    const hooks: QuotaHooks = { afterCommit: async (phase) => { if (phase === "confirm") throw new Error("lost reply"); } };
    expect((await request(user, { hooks })).status).toBe(200);
    await check("AC17 recovered commit", user.id, { C: 0, P: 0, R: 1, M: 1 });
    const attempt = await db.generationAttempt.findFirstOrThrow({ where: { userId: user.id } });
    expect((await createQuotaService(db).confirm(user.id, attempt.id, "{}")).status).toBe("SUCCEEDED");
    await check("AC17 repeated confirmation", user.id, { C: 0, P: 0, R: 1, M: 1 });
  });

  test("AC18 unknown outcomes keep facts, never promise refund", async () => {
    const a = await fixture(1, "[fail]");
    const blockRelease: QuotaHooks = { beforeTransaction: async (phase) => { if (phase === "release") throw new Error("unreachable"); } };
    expect(await request(a, { hooks: blockRelease })).toMatchObject({ status: 503, code: "OUTCOME_UNKNOWN" });
    await check("AC18 failed but reserved", a.id, { C: 0, P: 1, R: 0, M: 1 });
    events = [];
    const b = await fixture();
    const unknownCommit = {
      ...blockRelease,
      afterCommit: async (phase: string) => { if (phase === "confirm") throw new Error("lost reply"); },
    };
    expect(await request(b, { hooks: unknownCommit })).toMatchObject({ status: 503, code: "OUTCOME_UNKNOWN" });
    await check("AC18 committed but unconfirmed", b.id, { C: 0, P: 0, R: 1, M: 1 });
  });

  test("AC19 three held snapshots mix success/failure and reject fourth", async () => {
    const user = await fixture(3);
    const gate = deferred();
    let entered = 0;
    const steps = [deferred(), deferred(), deferred()];
    const model: typeof generateMockSchedule = async (tasks, hours) => {
      const outcome = generateMockSchedule(tasks, hours).then((value) => ({ value }), (error: unknown) => ({ error }));
      steps[entered++].resolve();
      await gate.promise;
      const settled = await outcome;
      if ("error" in settled) throw settled.error;
      return settled.value;
    };
    const requests = [request(user, { model })];
    await steps[0].promise;
    await db.task.updateMany({ where: { userId: user.id }, data: { description: "[fail]" } });
    requests.push(request(user, { model }));
    await steps[1].promise;
    await db.task.updateMany({ where: { userId: user.id }, data: { description: "ordinary" } });
    requests.push(request(user, { model }));
    await steps[2].promise;
    expect(await snapshot(user.id)).toEqual({ C: 0, P: 3, R: 0 });
    expect((await request(user)).status).toBe(402);
    expect(modelCounts().M).toBe(3);
    gate.resolve();
    expect((await Promise.all(requests)).map((r) => r.status)).toEqual([200, 502, 200]);
    await check("AC19", user.id, { C: 1, P: 0, R: 2, M: 3 });
    expect(modelCounts()).toEqual({ M: 3, succeeded: 2, failed: 1 });
  });

  test("AC20 independent Node processes share database admission", async () => {
    const user = await fixture();
    const children: ChildProcess[] = [];
    const ready: Promise<void>[] = [];
    const done: Promise<number>[] = [];
    for (let index = 0; index < 5; index++) {
      const child = spawn(process.execPath, [
        "--experimental-transform-types", "--import", "./tests/helpers/register-ts.mjs", "./tests/helpers/quota-worker.ts",
      ], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, TEST_DATABASE_URL: url } });
      children.push(child);
      let readyResolve!: () => void;
      let readyReject!: (error: Error) => void;
      ready.push(new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; }));
      const completion = new Promise<number>((resolve, reject) => {
        let finished = false;
        const fail = (error: Error) => {
          clearTimeout(timer);
          readyReject(error);
          reject(error);
        };
        const timer = setTimeout(() => fail(new Error("worker deadline")), 15000);
        child.on("error", fail);
        child.on("message", (message: any) => {
          if (message.type === "ready") readyResolve();
          if (message.type === "log") events.push(JSON.parse(message.line));
          if (message.type === "done") { finished = true; clearTimeout(timer); resolve(message.status); }
        });
        child.on("exit", (code) => { if (!finished) fail(new Error("worker exited before result: " + code)); });
        child.stderr?.on("data", (chunk) => { if (!String(chunk).includes("ExperimentalWarning")) observations.push({ workerStderr: String(chunk) }); });
      });
      // Startup can fail while the parent is still awaiting the ready barrier.
      void completion.catch(() => undefined);
      done.push(completion);
    }
    try {
      await Promise.all(ready);
      children.forEach((child) => child.send({ userId: user.id }));
      const statuses = await Promise.all(done);
      expect(statuses.sort()).toEqual([200, 402, 402, 402, 402]);
      await check("AC20 five processes", user.id, { C: 0, P: 0, R: 1, M: 1 });
    } finally { children.forEach((child) => child.kill()); }
  });

  test("AC22 failed refund write rolls back state and bounded retry succeeds", async () => {
    const user = await fixture(1, "[fail]");
    const once = failOnce("release");
    let releaseCalls = 0;
    const hooks: QuotaHooks = {
      ...once,
      beforeTransaction: async (phase) => {
        if (phase === "release" && ++releaseCalls === 2) {
          expect(await snapshot(user.id)).toEqual({ C: 0, P: 1, R: 0 });
        }
      },
    };
    expect(await request(user, { hooks })).toMatchObject({ status: 502, code: "PROVIDER_FAILED" });
    expect(releaseCalls).toBe(2);
    await check("AC22", user.id, { C: 1, P: 0, R: 0, M: 1 });
  });

  test("AC23 lost reserve reply never calls model", async () => {
    for (const unavailable of [false, true]) {
      const user = await fixture();
      const hooks: QuotaHooks = {
        afterCommit: async (phase) => { if (phase === "reserve") throw new Error("lost reply"); },
        beforeTransaction: async (phase) => { if (unavailable && phase === "release") throw new Error("unreachable"); },
      };
      expect(await request(user, { hooks })).toMatchObject({
        status: 503, code: unavailable ? "OUTCOME_UNKNOWN" : "DB_UNAVAILABLE",
      });
      await check("AC23 unavailable=" + unavailable, user.id, { C: unavailable ? 0 : 1, P: unavailable ? 1 : 0, R: 0, M: 0 });
    }
  });

  test("AC21 migration preserves legacy rows and refuses negative credits", async () => {
    const adminUrl = new URL(url!);
    adminUrl.pathname = "/postgres";
    const admin = new PrismaClient({ datasources: { db: { url: adminUrl.href } } });
    const suffix = Date.now();
    const migrationCases: unknown[] = [];
    try {
      for (const negative of [false, true]) {
        const name = "migration_" + suffix + "_" + (negative ? "negative" : "legacy") + "_quota_test";
        await admin.$executeRawUnsafe('CREATE DATABASE "' + name + '"');
        const fixtureUrl = new URL(url!);
        fixtureUrl.pathname = "/" + name;
        const fixtureDb = new PrismaClient({ datasources: { db: { url: fixtureUrl.href } } });
        const runSql = (sql: string) => {
          const connection = new URL(fixtureUrl);
          return spawnSync(process.execPath, ["scripts/verify-sql.mjs"], {
            input: sql, encoding: "utf8",
            env: { ...process.env, PGHOST: connection.hostname, PGPORT: connection.port, PGUSER: decodeURIComponent(connection.username),
              PGPASSWORD: decodeURIComponent(connection.password), PGDATABASE: name },
          });
        };
        try {
          expect(runSql(readFileSync("migrations/20261015081629_init/migration.sql", "utf8")).status).toBe(0);
          await fixtureDb.user.create({ data: { id: "legacy", credits: negative ? -1 : 2 } });
          await fixtureDb.task.create({ data: { userId: "legacy", description: "retained" } });
          await fixtureDb.planResult.create({ data: { userId: "legacy", content: "{}" }, select: { id: true } });
          const migrated = runSql(readFileSync("migrations/20261021133000_quota_reservation/migration.sql", "utf8"));
          expect(migrated.status === 0).toBe(!negative);
          expect((await fixtureDb.user.findUniqueOrThrow({ where: { id: "legacy" } })).credits).toBe(negative ? -1 : 2);
          expect(await fixtureDb.task.count()).toBe(1);
          if (!negative) {
            expect((await fixtureDb.planResult.findFirstOrThrow()).generationAttemptId).toBeNull();
            await expect(fixtureDb.user.update({ where: { id: "legacy" }, data: { credits: -1 } })).rejects.toThrow();
          } else {
            const tables = await fixtureDb.$queryRawUnsafe<any[]>("SELECT tablename FROM pg_tables WHERE tablename = 'GenerationAttempt'");
            expect(tables).toHaveLength(0);
          }
          migrationCases.push({ negative, exitCode: migrated.status, credits: negative ? -1 : 2, tasks: 1, results: 1, modelCalls: 0 });
        } finally {
          await fixtureDb.$disconnect();
          await admin.$executeRawUnsafe('DROP DATABASE "' + name + '"');
        }
      }
      observations.push({ label: "AC21", cases: migrationCases });
    } finally { await admin.$disconnect(); }
  });
});
