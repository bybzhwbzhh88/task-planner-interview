import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll } from "vitest";
import { validateTestDatabaseUrl } from "../../scripts/test-db.mjs";
import { createPlanStore } from "../../src/demo-ai-app/planStore";
import { generateMockSchedule } from "../../src/demo-ai-app/mockAi";
import type { GenerationDeps } from "../../src/demo-ai-app/generation";

const url = validateTestDatabaseUrl(process.env.QUOTA_TEST_DATABASE_URL);
export const admin = new PrismaClient({ datasources: { db: { url } } });
const clients: PrismaClient[] = [];
const users: string[] = [];
export async function account(credits: number, description = "学习并发控制") {
  const user = await admin.user.create({ data: { credits, tasks: { create: { description } } } });
  users.push(user.id);
  return user.id;
}
export async function connection() {
  const client = new PrismaClient({ datasources: { db: { url: `${url}${url.includes("?") ? "&" : "?"}connection_limit=1` } } });
  clients.push(client);
  await client.$connect();
  return client;
}
export function deps(client: PrismaClient): GenerationDeps {
  return { store: createPlanStore(client), generate: generateMockSchedule, newId: randomUUID, log: () => {} };
}
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
export async function state(userId: string) {
  const user = await admin.user.findUniqueOrThrow({ where: { id: userId } });
  return { credits: user.credits, results: await admin.planResult.count({ where: { userId } }) };
}
afterAll(async () => {
  // Only this file's UUID users are removed; never reset or truncate a database.
  await admin.planResult.deleteMany({ where: { userId: { in: users } } });
  await admin.task.deleteMany({ where: { userId: { in: users } } });
  await admin.user.deleteMany({ where: { id: { in: users } } });
  await Promise.all(clients.map(client => client.$disconnect()));
  await admin.$disconnect();
});
