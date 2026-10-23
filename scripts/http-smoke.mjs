import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { serialize, deserialize } from "superjson";

if (process.env.RUN_HTTP_SMOKE !== "1") throw new Error("Set RUN_HTTP_SMOKE=1 to create disposable local test accounts");
const base = "http://127.0.0.1:3001";
const db = new PrismaClient();
const users = [];
const usernames = [];
async function post(path, body, token) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
const operation = (name, args, token) => post(`/operations/${name}`, serialize(args), token);
async function account() {
  const username = `quota${randomBytes(8).toString("hex")}`;
  const password = randomBytes(20).toString("hex");
  usernames.push(username);
  assert.equal((await post("/auth/username/signup", { username, password })).status, 200);
  const identity = await db.authIdentity.findUniqueOrThrow({ where: { providerName_providerUserId: { providerName: "username", providerUserId: username } }, include: { auth: true } });
  const id = identity.auth.userId;
  assert.ok(id);
  users.push(id);
  const login = await post("/auth/username/login", { username, password });
  assert.equal(login.status, 200);
  assert.ok(login.body.sessionId);
  return { id, token: login.body.sessionId };
}
async function balance(id, credits) {
  await db.user.update({ where: { id }, data: { credits } });
}
async function check(id, credits, plans) {
  assert.equal((await db.user.findUniqueOrThrow({ where: { id } })).credits, credits);
  assert.equal(await db.planResult.count({ where: { userId: id } }), plans);
}
try {
  for (let attempt = 0; ; attempt++) {
    try {
      await fetch(base);
      break;
    } catch (error) {
      if (attempt >= 29) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  assert.equal((await operation("generate-plan", { hours: 8 })).status, 401);
  const a = await account();
  assert.equal((await operation("generate-plan", { hours: 8 }, a.token)).status, 400);
  const task = await operation("create-task", { description: "准备面试" }, a.token);
  assert.equal(task.status, 200);
  const taskId = deserialize(task.body).id;
  for (const hours of [0, 25, "8"]) {
    assert.equal((await operation("generate-plan", { hours }, a.token)).status, 400);
  }
  await check(a.id, 3, 0);
  console.log("A8 PASS: authentication, empty tasks and invalid hours rejected");

  assert.equal((await operation("generate-plan", { hours: 8 }, a.token)).status, 200);
  await check(a.id, 2, 1);
  console.log("A1 PASS: success charges once and persists");
  await balance(a.id, 0);
  assert.equal((await operation("generate-plan", { hours: 8 }, a.token)).status, 402);
  await check(a.id, 0, 1);
  console.log("A2 PASS: zero credits rejected");

  await balance(a.id, 1);
  await db.task.update({ where: { id: taskId }, data: { description: "[fail]" } });
  const failed = await operation("generate-plan", { hours: 8 }, a.token);
  assert.equal(failed.status, 502);
  await check(a.id, 1, 1);
  await db.task.update({ where: { id: taskId }, data: { description: "准备面试" } });
  assert.equal((await operation("generate-plan", { hours: 8 }, a.token)).status, 200);
  await check(a.id, 0, 2);
  console.log("A3/A6 PASS: failure refunds and retry succeeds");

  let plans = 2;
  for (const credits of [1, 3]) {
    await balance(a.id, credits);
    const results = await Promise.all(Array.from({ length: 10 }, () => operation("generate-plan", { hours: 8 }, a.token)));
    assert.equal(results.filter((r) => r.status === 200).length, credits);
    assert.equal(results.filter((r) => r.status === 402).length, 10 - credits);
    plans += credits;
    await check(a.id, 0, plans);
  }
  console.log("A4/A5 PASS: concurrent HTTP requests respect balances 1 and 3");
  const b = await account();
  assert.deepEqual(deserialize((await operation("get-plan-results", undefined, b.token)).body), []);
  assert.equal(deserialize((await operation("get-plan-results", undefined, a.token)).body).length, plans);
  assert.equal(deserialize((await operation("get-credits", undefined, a.token)).body), 0);
  console.log("A7 PASS: history is scoped to the authenticated user");
} finally {
  // Recover IDs even if signup succeeded but a subsequent assertion failed.
  const identities = await db.authIdentity.findMany({ where: { providerName: "username", providerUserId: { in: usernames } }, include: { auth: true } });
  const ids = [...new Set([...users, ...identities.map((i) => i.auth.userId).filter(Boolean)])];
  await db.planResult.deleteMany({ where: { userId: { in: ids } } });
  await db.task.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
}
