import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@prisma/client";
import { prisma } from "wasp/server";
import { generatePlan } from "../src/demo-ai-app/operations";

type Event = { event: string; callId: string };
type Context = Parameters<typeof generatePlan>[1];
const createdUsers: string[] = [];
let events: Event[];
let rejectResultFor: string | undefined;
let rejectDebitFor: string | undefined;

// Only inject storage faults here; transactions and all other queries use PostgreSQL.
prisma.$use(async (params, next) => {
  if (params.model === "PlanResult" && params.action === "create" && rejectResultFor) {
    const data = params.args.data;
    if ((data.userId ?? data.user?.connect?.id) === rejectResultFor) {
      throw new Error("Test: result storage unavailable");
    }
  }
  if (params.model === "User" && params.action === "update" &&
      params.args.where.id === rejectDebitFor && params.args.data.credits?.decrement === 1) {
    throw new Error("Test: credit update unavailable");
  }
  return next(params);
});

async function fixture(credits: number, description = "准备面试") {
  const user = await prisma.user.create({ data: { credits } });
  createdUsers.push(user.id);
  await prisma.task.create({ data: { userId: user.id, description } });
  return user;
}

function context(user?: User, cachedCredits = user?.credits): Context {
  // Authentication is exercised separately in the browser. Here the user is
  // authenticated, with an intentionally stale request snapshot in AC02/04.
  return {
    user: user ? { ...user, credits: cachedCredits } : undefined,
    entities: { User: prisma.user, Task: prisma.task, PlanResult: prisma.planResult },
  } as unknown as Context;
}

const generate = (user?: User, cachedCredits?: number) => generatePlan({ hours: 4 }, context(user, cachedCredits));
const count = (name: string) => events.filter(event => event.event === `mock-ai.${name}`).length;
async function state(user: User) {
  return {
    credits: (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits,
    results: await prisma.planResult.count({ where: { userId: user.id } }),
  };
}

beforeAll(async () => {
  const [row] = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (!row.name.endsWith("_test")) throw new Error("拒绝在非测试数据库运行额度验收。");
});

beforeEach(() => {
  events = [];
  vi.spyOn(console, "info").mockImplementation((message: unknown) => {
    if (typeof message === "string" && message.startsWith("{")) {
      events.push(JSON.parse(message));
    }
  });
});

afterEach(async () => {
  rejectResultFor = undefined;
  rejectDebitFor = undefined;
  console.log(JSON.stringify({
    started: count("started"), succeeded: count("succeeded"), failed: count("failed"),
    users: await Promise.all(createdUsers.map(id => state({ id } as User))),
  }));
  vi.restoreAllMocks();
  const ids = createdUsers.splice(0);
  await prisma.planResult.deleteMany({ where: { userId: { in: ids } } });
  await prisma.task.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

afterAll(() => prisma.$disconnect());

describe("日程额度验收（真实 PostgreSQL + 本地模拟接口）", () => {
  it("AC01 成功仅扣 1 额度并保存日程", async () => {
    const user = await fixture(3);
    const result = await generate(user);
    expect(result.tasks[0].name).toBe("准备面试");
    expect(await state(user)).toEqual({ credits: 2, results: 1 });
    expect(count("started")).toBe(1);
    expect(count("succeeded")).toBe(1);
    expect(events[0].callId).toBe(events[1].callId);
    const saved = await prisma.planResult.findFirstOrThrow({ where: { userId: user.id } });
    expect(JSON.parse(saved.content)).toEqual(result);
  });

  it("AC02 实时余额为 0 时拒绝旧上下文且不调用接口", async () => {
    const user = await fixture(0);
    await expect(generate(user, 3)).rejects.toMatchObject({ statusCode: 402 });
    expect(await state(user)).toEqual({ credits: 0, results: 0 });
    expect(count("started")).toBe(0);
  });

  it("AC03 明确失败不扣额度且返回可识别错误", async () => {
    const user = await fixture(1, "模拟失败 [fail]");
    await expect(generate(user)).rejects.toMatchObject({
      statusCode: 502, data: { code: "MOCK_PROVIDER_FAILED" },
    });
    expect(await state(user)).toEqual({ credits: 1, results: 0 });
    expect(count("started")).toBe(1);
    expect(count("failed")).toBe(1);
    expect(events[0].callId).toBe(events[1].callId);
  });

  it.each([["AC04", 1], ["AC05", 3]])("%s 同账号 10 个并发请求不能透支（初始 %i）", async (_id, credits) => {
    const user = await fixture(credits);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => generate(user, 3)));
    const successes = results.filter(result => result.status === "fulfilled");
    const failures = results.filter(result => result.status === "rejected");
    expect(successes).toHaveLength(credits);
    expect(failures).toHaveLength(10 - credits);
    for (const failure of failures) {
      if (failure.status === "rejected") expect(failure.reason).toMatchObject({ statusCode: 402 });
    }
    expect(await state(user)).toEqual({ credits: 0, results: credits });
    expect(count("started")).toBe(credits);
    expect(count("succeeded")).toBe(credits);
    expect(new Set(events.filter(event => event.event === "mock-ai.started").map(event => event.callId)).size).toBe(credits);
  });

  it("AC06 失败后仍可使用原有额度重试", async () => {
    const user = await fixture(1, "失败后恢复 [fail]");
    await expect(generate(user)).rejects.toBeDefined();
    expect(await state(user)).toEqual({ credits: 1, results: 0 });
    await prisma.task.updateMany({ where: { userId: user.id }, data: { description: "恢复正常" } });
    await generate(user);
    expect(await state(user)).toEqual({ credits: 0, results: 1 });
    expect(count("started")).toBe(2);
    expect(count("failed")).toBe(1);
    expect(count("succeeded")).toBe(1);
  });

  it("AC07 结果保存失败不扣额度，随后可以恢复", async () => {
    const user = await fixture(1);
    rejectResultFor = user.id;
    await expect(generate(user)).rejects.toBeDefined();
    expect(await state(user)).toEqual({ credits: 1, results: 0 });
    rejectResultFor = undefined;
    await generate(user);
    expect(await state(user)).toEqual({ credits: 0, results: 1 });
  });

  it("AC07 扣额失败必须回滚已经写入的结果", async () => {
    const user = await fixture(1);
    rejectDebitFor = user.id;
    await expect(generate(user)).rejects.toBeDefined();
    expect(await state(user)).toEqual({ credits: 1, results: 0 });
    rejectDebitFor = undefined;
    await generate(user);
    expect(await state(user)).toEqual({ credits: 0, results: 1 });
  });

  it("AC08 不同账号分别使用自己的任务和额度", async () => {
    const a = await fixture(1, "账号 A 的任务");
    const b = await fixture(1, "账号 B 的任务");
    const [resultA, resultB] = await Promise.all([generate(a), generate(b)]);
    expect(resultA.tasks.map(task => task.name)).toEqual(["账号 A 的任务"]);
    expect(resultB.tasks.map(task => task.name)).toEqual(["账号 B 的任务"]);
    expect(await state(a)).toEqual({ credits: 0, results: 1 });
    expect(await state(b)).toEqual({ credits: 0, results: 1 });
    expect(count("started")).toBe(2);
  });

  it("AC09 未登录不调用接口", async () => {
    await expect(generate()).rejects.toMatchObject({ statusCode: 401 });
    expect(count("started")).toBe(0);
  });
});
