import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbContainer = process.env.TEST_DB_CONTAINER ?? "task-planner-postgres";
const dbName = process.env.TEST_DB_NAME ?? "taskplanner_verify";
const dbUser = process.env.TEST_DB_USER ?? "taskplanner";
const dbPassword = process.env.TEST_DB_PASSWORD ?? "taskplanner";
const testPort = Number(process.env.QUOTA_TEST_PORT ?? 3101);
const apiUrl = `http://127.0.0.1:${testPort}`;
const password = "QuotaCheck123";

if (!/^[a-z0-9_]+$/.test(dbName)) {
  throw new Error("TEST_DB_NAME must contain only lowercase letters, numbers, and underscores.");
}

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  `postgresql://${dbUser}:${dbPassword}@127.0.0.1:5433/${dbName}?schema=public`;

const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl } },
});

let serverProcess;
let serverLogs = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureTestDatabase() {
  if (process.env.TEST_DATABASE_URL) {
    return;
  }

  const exists = execFileSync(
    "docker",
    [
      "exec",
      dbContainer,
      "psql",
      "-U",
      dbUser,
      "-d",
      "postgres",
      "-tAc",
      `SELECT 1 FROM pg_database WHERE datname = '${dbName}'`,
    ],
    { encoding: "utf8" },
  ).trim();

  if (exists !== "1") {
    execFileSync(
      "docker",
      ["exec", dbContainer, "createdb", "-U", dbUser, dbName],
      { stdio: "inherit" },
    );
  }
}

function migrateTestDatabase() {
  execFileSync(
    "npx",
    [
      "prisma",
      "migrate",
      "deploy",
      "--schema=.wasp/out/db/schema.prisma",
    ],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "inherit",
    },
  );
}

async function startTestServer() {
  const serverDir = path.join(root, ".wasp/out/server");
  serverProcess = spawn(
    process.execPath,
    [
      "--enable-source-maps",
      "-r",
      "dotenv/config",
      "bundle/server.js",
    ],
    {
      cwd: serverDir,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PORT: String(testPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  serverProcess.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    serverLogs += text;
    process.stdout.write(text);
  });
  serverProcess.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    serverLogs += text;
    process.stderr.write(text);
  });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Test server exited before becoming ready.\n${serverLogs}`);
    }
    try {
      const response = await fetch(`${apiUrl}/`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // The server is still starting.
    }
    await sleep(250);
  }

  throw new Error(`Test server did not become ready.\n${serverLogs}`);
}

async function postJson(pathname, body, sessionId) {
  const headers = { "content-type": "application/json" };
  if (sessionId) {
    headers.authorization = `Bearer ${sessionId}`;
  }
  const response = await fetch(`${apiUrl}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Keep the raw response for diagnostics.
  }
  return { response, text, json };
}

async function callAction(pathname, args, sessionId) {
  return postJson(pathname, { json: args }, sessionId);
}

async function createTestUser(label) {
  const username = `quota${label}${Date.now()}${randomUUID().slice(0, 6)}`;
  const signup = await postJson("/auth/username/signup", {
    username,
    password,
  });
  assert.equal(signup.response.status, 200, signup.text);

  const login = await postJson("/auth/username/login", {
    username,
    password,
  });
  assert.equal(login.response.status, 200, login.text);
  const sessionId = login.json?.sessionId;
  assert.ok(sessionId, "Login did not return a sessionId");

  const me = await fetch(`${apiUrl}/auth/me`, {
    headers: { authorization: `Bearer ${sessionId}` },
  });
  const meText = await me.text();
  assert.equal(me.status, 200, meText);
  const meJson = JSON.parse(meText);
  const userId = meJson?.json?.id;
  assert.ok(userId, "Could not read the test user id");

  return { userId, sessionId, username };
}

async function createTask(sessionId, description) {
  const result = await callAction(
    "/operations/create-task",
    { description },
    sessionId,
  );
  assert.equal(result.response.status, 200, result.text);
}

async function generatePlan(sessionId) {
  return callAction("/operations/generate-plan", { hours: 8 }, sessionId);
}

async function setCredits(userId, credits) {
  await prisma.user.update({
    where: { id: userId },
    data: { credits },
  });
}

async function getCredits(userId) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { credits: true },
  });
  return user.credits;
}

async function getPlanResultCount(userId) {
  return prisma.planResult.count({ where: { userId } });
}

function countLogs(event) {
  return serverLogs.split(`"event":"${event}"`).length - 1;
}

function assertStatuses(results, expected) {
  const statuses = results
    .map(({ response }) => response.status)
    .sort((left, right) => left - right);
  assert.deepEqual(statuses, expected);
}

async function resetTestData() {
  await prisma.planResult.deleteMany();
  await prisma.task.deleteMany();
  await prisma.user.deleteMany();
}

async function runChecks() {
  await resetTestData();

  {
    const user = await createTestUser("success");
    await createTask(user.sessionId, "Plan quota success case");
    const startedBefore = countLogs("mock-ai.started");
    const result = await generatePlan(user.sessionId);
    await sleep(100);

    assert.equal(result.response.status, 200, result.text);
    assert.equal(result.json?.json?.creditsRemaining, 2);
    assert.equal(await getCredits(user.userId), 2);
    assert.equal(await getPlanResultCount(user.userId), 1);
    assert.equal(countLogs("mock-ai.started") - startedBefore, 1);
    console.log("Q1 success: PASS");
  }

  {
    const user = await createTestUser("empty");
    await createTask(user.sessionId, "Plan quota empty case");
    await setCredits(user.userId, 0);
    const startedBefore = countLogs("mock-ai.started");
    const result = await generatePlan(user.sessionId);
    await sleep(100);

    assert.equal(result.response.status, 402, result.text);
    assert.equal(await getCredits(user.userId), 0);
    assert.equal(await getPlanResultCount(user.userId), 0);
    assert.equal(countLogs("mock-ai.started") - startedBefore, 0);
    console.log("Q2 insufficient credits: PASS");
  }

  {
    const user = await createTestUser("fail");
    await createTask(user.sessionId, "[fail] Plan quota provider failure");
    await setCredits(user.userId, 2);
    const startedBefore = countLogs("mock-ai.started");
    const failedBefore = countLogs("mock-ai.failed");
    const result = await generatePlan(user.sessionId);
    await sleep(100);

    assert.equal(result.response.status, 502, result.text);
    assert.equal(await getCredits(user.userId), 2);
    assert.equal(await getPlanResultCount(user.userId), 0);
    assert.equal(countLogs("mock-ai.started") - startedBefore, 1);
    assert.equal(countLogs("mock-ai.failed") - failedBefore, 1);
    console.log("Q3 provider failure: PASS");
  }

  {
    const user = await createTestUser("one");
    await createTask(user.sessionId, "Plan quota concurrent one credit");
    await setCredits(user.userId, 1);
    const startedBefore = countLogs("mock-ai.started");
    const results = await Promise.all(
      Array.from({ length: 4 }, () => generatePlan(user.sessionId)),
    );
    await sleep(100);

    assertStatuses(results, [200, 402, 402, 402]);
    assert.equal(await getCredits(user.userId), 0);
    assert.equal(await getPlanResultCount(user.userId), 1);
    assert.equal(countLogs("mock-ai.started") - startedBefore, 1);
    console.log("Q4 concurrency with one credit: PASS");
  }

  {
    const user = await createTestUser("three");
    await createTask(user.sessionId, "Plan quota concurrent three credits");
    await setCredits(user.userId, 3);
    const startedBefore = countLogs("mock-ai.started");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => generatePlan(user.sessionId)),
    );
    await sleep(100);

    assertStatuses(results, [200, 200, 200, 402, 402]);
    assert.equal(await getCredits(user.userId), 0);
    assert.equal(await getPlanResultCount(user.userId), 3);
    assert.equal(countLogs("mock-ai.started") - startedBefore, 3);
    console.log("Q5 concurrency with three credits: PASS");
  }
}

async function main() {
  ensureTestDatabase();
  migrateTestDatabase();
  await startTestServer();
  await runChecks();
  console.log("Quota verification completed successfully.");
}

main()
  .catch((error) => {
    process.exitCode = 1;
    console.error("Quota verification failed.");
    console.error(error);
    if (serverLogs) {
      console.error("Captured server logs:");
      console.error(serverLogs);
    }
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill("SIGTERM");
    }
  });
