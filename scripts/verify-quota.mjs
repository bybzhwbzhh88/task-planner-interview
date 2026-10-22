import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { serialize, deserialize } from "superjson";

const { values } = parseArgs({ options: {
  "base-url": { type: "string", default: "http://localhost:3001" },
  "server-log": { type: "string" },
  rounds: { type: "string", default: "10" },
  output: { type: "string", default: "test-results/quota/http.json" },
  "database-env": { type: "string", default: ".env.server" },
  help: { type: "boolean" },
} });
if (values.help) {
  console.log("node scripts/verify-quota.mjs --server-log <actual app log> [--base-url http://localhost:3001] [--rounds 10] [--database-env .env.server]\nUses real auth/RPC and read-only PostgreSQL inspection of its new test accounts. Run without concurrent manual model calls. Never prints passwords. Accounts remain as isolated quota_* fixtures.");
  process.exit(0);
}
const rounds = Number(values.rounds);
if (!Number.isInteger(rounds) || rounds < 1 || !values["server-log"]) throw new Error("Provide --server-log and positive integer --rounds");
const logPath = values["server-log"];
statSync(logPath);
process.loadEnvFile(values["database-env"]);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for read-only verification against the running API's database");
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const report = { startedAt: new Date().toISOString(), rounds, cases: [], passed: false };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function http(path, { token, args, raw = false, method = "POST" } = {}) {
  const response = await fetch(new URL(path, values["base-url"]), {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    ...(method === "GET" ? {} : { body: JSON.stringify(raw ? args : serialize(args)) }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(path + " returned non-JSON (" + response.status + ")"); }
  return { status: response.status, body: response.ok && !raw ? deserialize(body) : body };
}
const operation = (account, name, args) => http("/operations/" + name, { token: account?.token, args });
async function fresh(credits = 3, task = true) {
  const username = "quota_" + Date.now() + "_" + randomBytes(4).toString("hex");
  const password = "Test_" + randomBytes(18).toString("hex");
  const signup = await http("/auth/username/signup", { raw: true, args: { username, password } });
  assert.ok([200, 201].includes(signup.status), "signup");
  const login = await http("/auth/username/login", { raw: true, args: { username, password } });
  assert.equal(login.status, 200);
  assert.equal(typeof login.body.sessionId, "string");
  const account = { token: login.body.sessionId, username };
  const me = await http("/auth/me", { token: account.token, method: "GET" });
  assert.equal(me.status, 200);
  account.id = me.body.id;
  assert.equal(me.body.credits, 3);
  if (task) {
    const created = await operation(account, "create-task", { description: "quota verification" });
    assert.equal(created.status, 200);
  }
  for (let index = 3; index > credits; index--) assert.equal((await operation(account, "generate-plan", { hours: 8 })).status, 200);
  return account;
}
async function snapshot(account) {
  const user = await db.user.findUniqueOrThrow({ where: { id: account.id } });
  const state = {
    C: user.credits,
    P: await db.generationAttempt.count({ where: { userId: account.id, status: "RESERVED" } }),
    R: await db.planResult.count({ where: { userId: account.id } }),
  };
  const me = await http("/auth/me", { token: account.token, method: "GET" });
  assert.equal(me.status, 200);
  assert.equal(me.body.credits, state.C, "auth/UI source must match PostgreSQL");
  const results = await operation(account, "get-plan-results");
  assert.equal(results.status, 200);
  assert.equal(results.body.length, state.R);
  const attempts = await db.generationAttempt.findMany({ where: { userId: account.id }, include: { result: true } });
  for (const attempt of attempts) {
    assert.equal(!!attempt.result, attempt.status === "SUCCEEDED");
    if (attempt.result) assert.equal(attempt.result.userId, account.id);
  }
  return state;
}
function providerEvents(offset) {
  const buffer = readFileSync(logPath);
  assert.ok(buffer.length >= offset, "server log was truncated");
  return buffer.subarray(offset).toString("utf8").split("\n").flatMap((line) => {
    const match = line.match(/\{"event":"mock-ai\.(started|succeeded|failed)","callId":"[^"]+"\}/);
    return match ? [JSON.parse(match[0])] : [];
  });
}
async function scenario(id, account, action, expected) {
  const before = await snapshot(account);
  const offset = statSync(logPath).size;
  const responses = await action();
  const after = await snapshot(account);
  await delay(100);
  const events = providerEvents(offset);
  const starts = events.filter((event) => event.event === "mock-ai.started");
  const successes = events.filter((event) => event.event === "mock-ai.succeeded");
  const failures = events.filter((event) => event.event === "mock-ai.failed");
  assert.equal(new Set(starts.map((event) => event.callId)).size, starts.length);
  assert.equal(starts.length, successes.length + failures.length, "missing model terminal logs");
  for (const event of [...successes, ...failures]) assert.ok(starts.some((entry) => entry.callId === event.callId));
  const observed = {
    id, username: account.username, before, after, deltaR: after.R - before.R,
    statuses: responses.map((response) => response.status),
    codes: responses.map((response) => response.body?.data?.code ?? null),
    model: { started: starts.length, succeeded: successes.length, failed: failures.length },
    callIds: starts.map((event) => event.callId),
  };
  report.cases.push(observed);
  assert.equal(after.C, expected.C, id + " credits");
  assert.equal(after.P, 0, id + " no leaked reservations");
  assert.equal(observed.deltaR, expected.R, id + " results");
  if (expected.failureBatch) {
    assert.ok(observed.statuses.every((status) => status === 402 || status === 502));
    assert.equal(starts.length, observed.statuses.filter((status) => status === 502).length);
    assert.equal(failures.length, starts.length);
  } else {
    assert.deepEqual([...observed.statuses].sort(), [...expected.statuses].sort(), id + " responses");
    assert.equal(starts.length, expected.M, id + " actual calls");
  }
  observed.passed = true;
  console.log("PASS", id, JSON.stringify({ statuses: observed.statuses, before, after, model: observed.model, deltaR: observed.deltaR }));
}
const one = async (account, args = { hours: 8 }) => [await operation(account, "generate-plan", args)];
try {
  const initial = await fresh();
  await scenario("AC01", initial, async () => [], { C: 3, R: 0, M: 0, statuses: [] });
  await scenario("AC02", initial, () => one(initial), { C: 2, R: 1, M: 1, statuses: [200] });
  const last = await fresh(1);
  await scenario("AC03", last, () => one(last), { C: 0, R: 1, M: 1, statuses: [200] });
  await scenario("AC04", last, () => one(last), { C: 0, R: 0, M: 0, statuses: [402] });

  const failing = await fresh(1);
  const marker = await operation(failing, "create-task", { description: "[fail] explicit provider failure" });
  assert.equal(marker.status, 200);
  await scenario("AC05", failing, () => one(failing), { C: 1, R: 0, M: 1, statuses: [502] });
  assert.equal((await operation(failing, "delete-task", { id: marker.body.id })).status, 200);
  await scenario("AC06", failing, () => one(failing), { C: 0, R: 1, M: 1, statuses: [200] });

  for (const credits of [1, 3]) {
    for (let round = 1; round <= rounds; round++) {
      const account = await fresh(credits);
      await scenario((credits === 1 ? "AC07" : "AC08") + "-" + round, account, async () => {
        const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => operation(account, "generate-plan", { hours: 8 })));
        assert.ok(outcomes.every((entry) => entry.status === "fulfilled"), "concurrent transport failure");
        return outcomes.map((entry) => entry.value);
      }, { C: 0, R: credits, M: credits, statuses: [...Array(credits).fill(200), ...Array(5 - credits).fill(402)] });
    }
  }
  const failureBatch = await fresh(1);
  await operation(failureBatch, "create-task", { description: "[fail] concurrency" });
  await scenario("AC09-unbarriered", failureBatch, () => Promise.all(Array.from({ length: 3 }, () => operation(failureBatch, "generate-plan", { hours: 8 }))), { C: 1, R: 0, failureBatch: true });

  const invalid = await fresh();
  await scenario("AC12-unauthenticated", invalid, () => one(undefined), { C: 3, R: 0, M: 0, statuses: [401] });
  for (const hours of [0, 25, "8"]) {
    await scenario("AC12-hours-" + hours, invalid, () => one(invalid, { hours }), { C: 3, R: 0, M: 0, statuses: [400] });
  }
  const empty = await fresh(3, false);
  await scenario("AC12-empty", empty, () => one(empty), { C: 3, R: 0, M: 0, statuses: [400] });
  for (const hours of [1, 24, 1.25]) {
    const account = await fresh();
    await scenario("AC12-valid-" + hours, account, () => one(account, { hours }), { C: 2, R: 1, M: 1, statuses: [200] });
  }
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  await db.$disconnect();
  report.finishedAt = new Date().toISOString();
  mkdirSync("test-results/quota", { recursive: true });
  writeFileSync(values.output, JSON.stringify(report, null, 2));
}
