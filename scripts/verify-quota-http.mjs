import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";

const { values } = parseArgs({ options: {
  "base-url": { type: "string", default: "http://localhost:3001" },
  "log-file": { type: "string" },
  rounds: { type: "string", default: "10" },
} });
if (process.env.QUOTA_ALLOW_HTTP_TESTS !== "1" || !process.env.DATABASE_URL) {
  throw new Error("Set QUOTA_ALLOW_HTTP_TESTS=1 and DATABASE_URL to the running local app database; see docs/VERIFICATION.md.");
}
const baseUrl = new URL(values["base-url"]);
const databaseUrl = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname)) {
  throw new Error("This script only supports a local app and local non-production PostgreSQL.");
}
if (!values["log-file"]) throw new Error("Pass --log-file with the running server's log file. Do not generate from other clients during this test.");
const rounds = Number(values.rounds);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error("--rounds must be an integer from 1 to 100.");
const db = new PrismaClient();
const ownedIds = [];
const results = [];

function calls() {
  const log = readFileSync(values["log-file"], "utf8");
  return (log.match(/"event":"mock-ai.started"/g) || []).length;
}
async function request(path, body, token, method = "POST") {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { invalidJson: true }; }
  return { status: response.status, data };
}
async function account(credits) {
  const username = `quota${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const password = `${randomUUID()}!aA1`;
  assert.equal((await request("/auth/username/signup", { username, password })).status, 200);
  const identity = await db.authIdentity.findUniqueOrThrow({
    where: { providerName_providerUserId: { providerName: "username", providerUserId: username } },
    include: { auth: true },
  });
  const id = identity.auth.userId;
  assert.ok(id, "The account created through HTTP must exist in DATABASE_URL.");
  ownedIds.push(id);
  const login = await request("/auth/username/login", { username, password });
  assert.equal(login.status, 200);
  const token = login.data.sessionId;
  const me = await request("/auth/me", undefined, token, "GET");
  assert.equal(me.data.json.id, id);
  assert.equal(me.data.json.credits, 3, "New accounts must start with three credits.");
  await db.user.update({ where: { id }, data: { credits } });
  return { id, token };
}
async function createTask(account, description = "Prepare a repeatable interview demonstration") {
  const response = await request("/operations/create-task", { json: { description } }, account.token);
  assert.equal(response.status, 200);
  return response.data.json.id;
}
async function generate(account, hours = 8) {
  return request("/operations/generate-plan", { json: { hours } }, account.token);
}
async function verify(name, account, action, expected) {
  const started = calls();
  const responses = await action();
  const state = {
    statuses: responses.map(r => r.status).sort((a, b) => a - b),
    modelStarted: calls() - started,
    credits: (await db.user.findUniqueOrThrow({ where: { id: account.id } })).credits,
    results: await db.planResult.count({ where: { userId: account.id } }),
  };
  assert.deepEqual(state, expected, name);
  results.push({ name, ...state });
  console.log(JSON.stringify({ name, ...state }));
  return responses;
}

try {
  calls(); // Fail before creating accounts if the server log is unreadable.
  const ok = await account(3);
  await createTask(ok);
  await verify("AC01-success", ok, async () => [await generate(ok)], {
    statuses: [200], modelStarted: 1, credits: 2, results: 1,
  });

  const empty = await account(0);
  await createTask(empty);
  const rejected = await verify("AC02-no-credit", empty, async () => [await generate(empty)], {
    statuses: [402], modelStarted: 0, credits: 0, results: 0,
  });
  assert.equal(rejected[0].data.data.code, "NO_CREDITS");

  const failure = await account(1);
  const failedTaskId = await createTask(failure, "[fail] explicit local provider failure");
  const failed = await verify("AC03-model-failure", failure, async () => [await generate(failure)], {
    statuses: [502], modelStarted: 1, credits: 1, results: 0,
  });
  assert.equal(failed[0].data.data.code, "MODEL_FAILED");
  assert.equal((await request("/operations/delete-task", { json: { id: failedTaskId } }, failure.token)).status, 200);
  await createTask(failure);
  await verify("AC06-recovery", failure, async () => [await generate(failure)], {
    statuses: [200], modelStarted: 1, credits: 0, results: 1,
  });

  const invalid = await account(1);
  await verify("AC07-input-and-auth", invalid, async () => {
    const unauthenticated = await request("/operations/generate-plan", { json: { hours: 8 } });
    const noTasks = await generate(invalid);
    await createTask(invalid);
    return [unauthenticated, noTasks, ...await Promise.all([0, 25, "8", null].map(h => generate(invalid, h)))];
  }, { statuses: [400, 400, 400, 400, 400, 401], modelStarted: 0, credits: 1, results: 0 });

  for (const credits of [1, 3]) {
    for (let round = 1; round <= rounds; round++) {
      const current = await account(credits);
      await createTask(current);
      await verify(`AC0${credits === 1 ? 4 : 5}-round-${round}`, current,
        () => Promise.all(Array.from({ length: 10 }, () => generate(current))), {
          statuses: [...Array(credits).fill(200), ...Array(10 - credits).fill(402)],
          modelStarted: credits, credits: 0, results: credits,
        });
    }
  }
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/quota-http.json", JSON.stringify({
    recordedAt: new Date().toISOString(), roundsPerBalance: rounds, results,
  }, null, 2));
  console.log(`PASS: ${results.length} scenarios; report: test-results/quota-http.json`);
} finally {
  try {
    // Only the exact accounts created by this process; no truncate/reset.
    await db.$transaction([
      db.planResult.deleteMany({ where: { userId: { in: ownedIds } } }),
      db.task.deleteMany({ where: { userId: { in: ownedIds } } }),
      db.user.deleteMany({ where: { id: { in: ownedIds } } }),
    ]);
  } finally { await db.$disconnect(); }
}
