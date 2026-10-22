import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { generateMockSchedule } from "../src/demo-ai-app/mockAi.ts";
import { NoCreditError, runWithReservedCredit } from "../src/demo-ai-app/quota.ts";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.includes("task_planner_quota_test")) {
  throw new Error(
    "Set QUOTA_TEST_DATABASE_URL to an isolated database whose name contains task_planner_quota_test",
  );
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require(
  process.env.QUOTA_PRISMA_MODULE || "@prisma/client",
);
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const createdUserIds = [];
const mockEvents = [];
const originalInfo = console.info;
console.info = (...args) => {
  try {
    const event = JSON.parse(args[0]);
    if (event.event?.startsWith("mock-ai.")) mockEvents.push(event);
  } catch {
    // Keep other logs untouched.
  }
  originalInfo(...args);
};

const quotaStore = {
  async reserveCredit(userId) {
    const result = await prisma.user.updateMany({
      where: { id: userId, credits: { gt: 0 } },
      data: { credits: { decrement: 1 } },
    });
    return result.count === 1;
  },
  async refundCredit(userId) {
    await prisma.user.update({
      where: { id: userId },
      data: { credits: { increment: 1 } },
    });
  },
};

async function userWithTask(credits, description) {
  const user = await prisma.user.create({ data: { credits } });
  createdUserIds.push(user.id);
  await prisma.task.create({ data: { userId: user.id, description } });
  return user.id;
}

async function generate(userId) {
  const tasks = await prisma.task.findMany({ where: { userId } });
  return runWithReservedCredit(quotaStore, userId, async () => {
    const schedule = await generateMockSchedule(tasks, 8);
    await prisma.planResult.create({
      data: { userId, content: JSON.stringify(schedule) },
    });
    return schedule;
  });
}

async function state(userId) {
  const [user, results] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    prisma.planResult.count({ where: { userId } }),
  ]);
  return { credits: user.credits, results };
}

function eventCount(from, event) {
  return mockEvents.slice(from).filter((entry) => entry.event === event).length;
}

try {
  await prisma.$connect();

  const successId = await userWithTask(1, "ordinary task");
  let from = mockEvents.length;
  await generate(successId);
  assert.deepEqual(await state(successId), { credits: 0, results: 1 });
  assert.equal(eventCount(from, "mock-ai.started"), 1);
  assert.equal(eventCount(from, "mock-ai.succeeded"), 1);
  console.log("PASS V1 success: one result and one debit");

  const emptyId = await userWithTask(0, "ordinary task");
  from = mockEvents.length;
  await assert.rejects(generate(emptyId), NoCreditError);
  assert.deepEqual(await state(emptyId), { credits: 0, results: 0 });
  assert.equal(eventCount(from, "mock-ai.started"), 0);
  console.log("PASS V2 zero credit: no provider call");

  const failedId = await userWithTask(1, "[fail] task");
  from = mockEvents.length;
  await assert.rejects(generate(failedId), /Mock provider explicitly rejected/);
  assert.deepEqual(await state(failedId), { credits: 1, results: 0 });
  assert.equal(eventCount(from, "mock-ai.started"), 1);
  assert.equal(eventCount(from, "mock-ai.failed"), 1);
  console.log("PASS V3 provider failure: reservation refunded");

  await prisma.task.updateMany({
    where: { userId: failedId },
    data: { description: "repaired task" },
  });
  await generate(failedId);
  assert.deepEqual(await state(failedId), { credits: 0, results: 1 });
  console.log("PASS V4 retry: successful result consumes one credit");

  const saveFailureId = await userWithTask(1, "save failure task");
  await assert.rejects(
    runWithReservedCredit(quotaStore, saveFailureId, () =>
      prisma.planResult.create({ data: { userId: saveFailureId, content: null } }),
    ),
  );
  assert.deepEqual(await state(saveFailureId), { credits: 1, results: 0 });
  console.log("PASS V4a persistence failure: reservation refunded");

  const parallelId = await userWithTask(1, "parallel task");
  from = mockEvents.length;
  const parallel = await Promise.allSettled([
    generate(parallelId),
    generate(parallelId),
  ]);
  assert.equal(parallel.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(
    parallel.filter(
      (item) => item.status === "rejected" && item.reason instanceof NoCreditError,
    ).length,
    1,
  );
  assert.equal(eventCount(from, "mock-ai.started"), 1);
  assert.deepEqual(await state(parallelId), { credits: 0, results: 1 });
  console.log("PASS V5 concurrent success: one provider call, no overdraft");

  const parallelFailId = await userWithTask(1, "[fail] parallel task");
  from = mockEvents.length;
  const parallelFail = await Promise.allSettled([
    generate(parallelFailId),
    generate(parallelFailId),
  ]);
  assert.equal(
    parallelFail.filter((item) => item.status === "rejected" && item.reason instanceof NoCreditError).length,
    1,
  );
  assert.equal(eventCount(from, "mock-ai.started"), 1);
  assert.deepEqual(await state(parallelFailId), { credits: 1, results: 0 });
  console.log("PASS V6 concurrent failure: one provider call, credit restored");
} finally {
  console.info = originalInfo;
  if (createdUserIds.length > 0) {
    await prisma.planResult.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.task.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
}
