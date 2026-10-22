import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { generateMockSchedule } from "../src/demo-ai-app/mockAi";
import {
  generatePlanWithQuota,
  QuotaError,
  readCredits,
  type QuotaDeps,
} from "../src/demo-ai-app/quota";

const HOURS = 8;

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required. Point it at a disposable PostgreSQL database.",
  );
}
if (process.env.DATABASE_URL === testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL must point to a different database than DATABASE_URL.",
  );
}

function withConnectionLimit(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("connection_limit", "10");
  return parsed.toString();
}

const prisma = new PrismaClient({
  datasources: { db: { url: withConnectionLimit(testDatabaseUrl) } },
});

const createdUserIds: string[] = [];

async function createUser(credits: number) {
  const user = await prisma.user.create({ data: { credits } });
  createdUserIds.push(user.id);
  return user;
}

function createTask(userId: string, description: string, time = "1") {
  return prisma.task.create({ data: { userId, description, time } });
}

function generate(
  userId: string | null,
  hours: unknown = HOURS,
  overrides: Partial<QuotaDeps> = {},
) {
  return generatePlanWithQuota(
    { userId, hours },
    { db: prisma, generate: generateMockSchedule, ...overrides },
  );
}

function planResultCount(userId: string) {
  return prisma.planResult.count({ where: { userId } });
}

function spyOnModelStarts() {
  const spy = vi.spyOn(console, "info").mockImplementation(() => {});

  return () =>
    spy.mock.calls.filter(([message]) => {
      return (
        typeof message === "string" &&
        message.includes('"event":"mock-ai.started"')
      );
    }).length;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
) {
  const start = Date.now();

  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  vi.restoreAllMocks();

  if (createdUserIds.length === 0) {
    return;
  }

  const userIds = createdUserIds.splice(0);
  await prisma.planResult.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.task.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("额度集成测试（真实 PostgreSQL）", () => {
  it("A1 成功：扣 1 额度并保存 1 条结果", async () => {
    const countStarts = spyOnModelStarts();
    const user = await createUser(3);
    await createTask(user.id, "写周报");

    const schedule = await generate(user.id);

    expect(schedule.tasks).toHaveLength(1);
    expect(await readCredits(prisma, user.id)).toBe(2);
    expect(await planResultCount(user.id)).toBe(1);
    expect(countStarts()).toBe(1);
  });

  it("A2 无额度：402，不调用模型，不写结果", async () => {
    const countStarts = spyOnModelStarts();
    const user = await createUser(0);
    await createTask(user.id, "写周报");

    await expect(generate(user.id)).rejects.toMatchObject({ status: 402 });

    expect(countStarts()).toBe(0);
    expect(await readCredits(prisma, user.id)).toBe(0);
    expect(await planResultCount(user.id)).toBe(0);
  });

  it("A3 模型失败：回滚额度；删除 [fail] 后可重试成功", async () => {
    const countStarts = spyOnModelStarts();
    const user = await createUser(1);
    await createTask(user.id, "普通任务");
    const failingTask = await createTask(user.id, "会失败 [fail]");

    await expect(generate(user.id)).rejects.toMatchObject({ status: 502 });
    expect(countStarts()).toBe(1);
    expect(await readCredits(prisma, user.id)).toBe(1);
    expect(await planResultCount(user.id)).toBe(0);

    await prisma.task.delete({ where: { id: failingTask.id } });
    await expect(generate(user.id)).resolves.toBeDefined();

    expect(countStarts()).toBe(2);
    expect(await readCredits(prisma, user.id)).toBe(0);
    expect(await planResultCount(user.id)).toBe(1);
  });

  it("A4 最后 1 个额度：5 并发只有 1 次成功", async () => {
    const countStarts = spyOnModelStarts();
    const user = await createUser(1);
    await createTask(user.id, "普通任务");

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => generate(user.id)),
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toMatchObject({
        status: 402,
      });
    }

    expect(countStarts()).toBe(1);
    expect(await readCredits(prisma, user.id)).toBe(0);
    expect(await planResultCount(user.id)).toBe(1);
  });

  it("A5 多额度竞争：3 额度、10 并发只有 3 次成功", async () => {
    const countStarts = spyOnModelStarts();
    const user = await createUser(3);
    await createTask(user.id, "普通任务");

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => generate(user.id)),
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(7);
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toMatchObject({
        status: 402,
      });
    }

    expect(countStarts()).toBe(3);
    expect(await readCredits(prisma, user.id)).toBe(0);
    expect(await planResultCount(user.id)).toBe(3);
  });

  it("A6 失败释放：首个回滚后，等待中的第二个取得额度", async () => {
    const countStarts = spyOnModelStarts();
    const user = await createUser(1);
    await createTask(user.id, "普通任务");
    const failingTask = await createTask(user.id, "会失败 [fail]");

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    let generateCalls = 0;
    const gatedGenerate: QuotaDeps["generate"] = async (tasks, hours) => {
      generateCalls += 1;
      if (generateCalls === 1) {
        await firstGate;
      }
      return generateMockSchedule(tasks, hours);
    };

    const first = generate(user.id, HOURS, { generate: gatedGenerate });
    const firstResult = Promise.allSettled([first]);
    let second: Promise<unknown> | undefined;

    try {
      await waitFor(() => generateCalls === 1);
      await prisma.task.delete({ where: { id: failingTask.id } });
      second = generate(user.id, HOURS, { generate: gatedGenerate });
      void second.catch(() => undefined);

      // Observe the blocked UPDATE in PostgreSQL before releasing the first call.
      await waitFor(async () => {
        const [waiting] = await prisma.$queryRaw<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND state = 'active'
            AND wait_event_type = 'Lock'
            AND query LIKE 'UPDATE %'
            AND query LIKE '%"User"%'
            AND cardinality(pg_blocking_pids(pid)) > 0
        `;
        return waiting.count > 0;
      });

      expect(generateCalls).toBe(1);
      expect(countStarts()).toBe(0);
      releaseFirst();

      expect((await firstResult)[0]).toMatchObject({
        status: "rejected",
        reason: { status: 502 },
      });
      await expect(second).resolves.toBeDefined();
    } finally {
      releaseFirst();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }

    expect(generateCalls).toBe(2);
    expect(countStarts()).toBe(2);
    expect(await readCredits(prisma, user.id)).toBe(0);
    expect(await planResultCount(user.id)).toBe(1);
  });

  it("A7 保存失败：模型已调用，但额度与结果回滚", async () => {
    const countStarts = spyOnModelStarts();
    const user = await createUser(1);
    await createTask(user.id, "普通任务");

    const persist: NonNullable<QuotaDeps["persist"]> = async (tx, data) => {
      await tx.planResult.create({ data });
      throw new Error("simulated persist failure");
    };

    const error = await generate(user.id, HOURS, { persist }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as { status?: number }).status).not.toBe(502);
    expect(countStarts()).toBe(1);
    expect(await readCredits(prisma, user.id)).toBe(1);
    expect(await planResultCount(user.id)).toBe(0);
  });

  it("A8 未登录：401，不调用模型", async () => {
    const countStarts = spyOnModelStarts();

    await expect(generate(null)).rejects.toMatchObject({ status: 401 });

    expect(countStarts()).toBe(0);
  });

  it("A9 输入边界：非法时长 400，1/24 可生成", async () => {
    const countStarts = spyOnModelStarts();
    const user = await createUser(2);
    await createTask(user.id, "普通任务");

    for (const hours of [0, 25, Number.NaN, Infinity, -Infinity, "8"] as const) {
      await expect(generate(user.id, hours)).rejects.toMatchObject({
        status: 400,
      });
    }

    expect(countStarts()).toBe(0);
    expect(await readCredits(prisma, user.id)).toBe(2);

    await expect(generate(user.id, 1)).resolves.toBeDefined();
    await expect(generate(user.id, 24)).resolves.toBeDefined();

    expect(countStarts()).toBe(2);
    expect(await readCredits(prisma, user.id)).toBe(0);
    expect(await planResultCount(user.id)).toBe(2);
  });

  it("A10 无任务：400，不扣费不调用模型", async () => {
    const countStarts = spyOnModelStarts();
    const user = await createUser(1);

    await expect(generate(user.id)).rejects.toMatchObject({ status: 400 });

    expect(countStarts()).toBe(0);
    expect(await readCredits(prisma, user.id)).toBe(1);
    expect(await planResultCount(user.id)).toBe(0);
  });

  it("A11 账号隔离：两个账号各 1 额度，互不影响", async () => {
    const countStarts = spyOnModelStarts();
    const firstUser = await createUser(1);
    const secondUser = await createUser(1);
    await createTask(firstUser.id, "用户一的任务");
    await createTask(secondUser.id, "用户二的任务");

    const schedules = await Promise.all([
      generate(firstUser.id),
      generate(secondUser.id),
    ]);

    expect(schedules[0].tasks.map((task) => task.name)).toEqual(["用户一的任务"]);
    expect(schedules[1].tasks.map((task) => task.name)).toEqual(["用户二的任务"]);

    expect(await readCredits(prisma, firstUser.id)).toBe(0);
    expect(await readCredits(prisma, secondUser.id)).toBe(0);
    expect(await planResultCount(firstUser.id)).toBe(1);
    expect(await planResultCount(secondUser.id)).toBe(1);
    expect(countStarts()).toBe(2);
  });

  it("A13 余额新鲜度：readCredits 直接读数据库", async () => {
    const user = await createUser(3);

    await prisma.user.update({
      where: { id: user.id },
      data: { credits: 5 },
    });

    expect(await readCredits(prisma, user.id)).toBe(5);
  });

  it("QuotaError 保留外部状态码，供 operations 映射", () => {
    expect(new QuotaError(402, "no credits").status).toBe(402);
  });
});
