import { randomUUID } from "node:crypto";
import type { User } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { generatePlan } from "../src/demo-ai-app/operations";
import { prisma } from "./wasp-server";

type ActionContext = Parameters<typeof generatePlan>[1];
const ownedUserIds: string[] = [];

function contextFor(user: User | null): ActionContext {
  return {
    user,
    entities: {
      User: prisma.user,
      Task: prisma.task,
      PlanResult: prisma.planResult,
    },
  } as unknown as ActionContext;
}

async function createUser(credits: number, description: string | null = "写报告") {
  const id = `quota-test-${randomUUID()}`;
  // Register ownership before creation so cleanup is safe even if setup fails.
  ownedUserIds.push(id);
  return prisma.user.create({
    data: {
      id,
      credits,
      ...(description === null ? {} : { tasks: { create: { description } } }),
    },
  });
}

function modelEvents(event: string) {
  return vi.mocked(console.info).mock.calls.flatMap(([line]) => {
    if (typeof line !== "string" || !line.startsWith("{")) return [];
    const record = JSON.parse(line);
    return record.event === event ? [record] : [];
  });
}

async function expectState(userId: string, credits: number, results: number) {
  expect(await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
    .toMatchObject({ credits });
  expect(await prisma.planResult.count({ where: { userId } })).toBe(results);
}

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Never reset/truncate tables: delete only users created by this test run.
  const ids = ownedUserIds.splice(0);
  await prisma.planResult.deleteMany({ where: { userId: { in: ids } } });
  await prisma.task.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("真实 PostgreSQL 上的日程额度处理", () => {
  it("A1: 成功只扣一次并保存结果，不采用旧的零余额快照", async () => {
    const user = await createUser(3);
    const schedule = await generatePlan({ hours: 8 }, contextFor({ ...user, credits: 0 }));

    await expectState(user.id, 2, 1);
    const saved = await prisma.planResult.findFirstOrThrow({ where: { userId: user.id } });
    expect(JSON.parse(saved.content)).toEqual(schedule);
    expect(modelEvents("mock-ai.started")).toHaveLength(1);
    expect(modelEvents("mock-ai.succeeded")).toHaveLength(1);
    expect(modelEvents("mock-ai.started")[0].callId)
      .toBe(modelEvents("mock-ai.succeeded")[0].callId);
  });

  it("A2: 数据库余额为零时不调用模型，即使请求快照还有额度", async () => {
    const user = await createUser(0);
    await expect(generatePlan({ hours: 8 }, contextFor({ ...user, credits: 3 })))
      .rejects.toMatchObject({ statusCode: 402 });

    await expectState(user.id, 0, 0);
    expect(modelEvents("mock-ai.started")).toHaveLength(0);
  });

  it("A3: 模型明确失败返还额度，移除失败任务后可以重试", async () => {
    const user = await createUser(1, "[fail] 写报告");
    await expect(generatePlan({ hours: 8 }, contextFor(user)))
      .rejects.toMatchObject({ statusCode: 502 });

    await expectState(user.id, 1, 0);
    expect(modelEvents("mock-ai.started")).toHaveLength(1);
    expect(modelEvents("mock-ai.failed")).toHaveLength(1);
    expect(modelEvents("mock-ai.started")[0].callId)
      .toBe(modelEvents("mock-ai.failed")[0].callId);

    await prisma.task.updateMany({ where: { userId: user.id }, data: { description: "写报告" } });
    await generatePlan({ hours: 8 }, contextFor(user));
    await expectState(user.id, 0, 1);
    expect(modelEvents("mock-ai.started")).toHaveLength(2);
    expect(modelEvents("mock-ai.succeeded")).toHaveLength(1);
  });

  it.each([1, 3])("A4/A5: %i 次额度下同时请求 10 次，只调用有额度的次数", async (credits) => {
    const user = await createUser(credits);
    const requests = await Promise.allSettled(
      Array.from({ length: 10 }, () => generatePlan({ hours: 8 }, contextFor(user))),
    );

    const successful = requests.filter((request) => request.status === "fulfilled");
    const rejected = requests.filter((request) => request.status === "rejected");
    expect(successful).toHaveLength(credits);
    expect(rejected).toHaveLength(10 - credits);
    for (const request of rejected) {
      expect(request.reason).toMatchObject({ statusCode: 402 });
    }
    await expectState(user.id, 0, credits);
    expect(modelEvents("mock-ai.started")).toHaveLength(credits);
    expect(modelEvents("mock-ai.succeeded")).toHaveLength(credits);
    expect(new Set(modelEvents("mock-ai.started").map((event) => event.callId)).size)
      .toBe(credits);
  });

  it("A6: 保存失败时返还预占额度，不留下结果", async () => {
    const user = await createUser(1);
    vi.spyOn(prisma.planResult, "create").mockRejectedValueOnce(new Error("injected save failure"));

    await expect(generatePlan({ hours: 8 }, contextFor(user)))
      .rejects.toMatchObject({ statusCode: 502 });
    await expectState(user.id, 1, 0);
    expect(modelEvents("mock-ai.started")).toHaveLength(1);
    expect(modelEvents("mock-ai.succeeded")).toHaveLength(1);
  });

  it("A7: 返还失败时报告状态待确认，不谎报已返还", async () => {
    const user = await createUser(1, "[fail] 写报告");
    vi.spyOn(prisma.user, "update").mockRejectedValueOnce(new Error("injected refund failure"));

    const error = await generatePlan({ hours: 8 }, contextFor(user)).catch((failure) => failure);
    expect(error).toMatchObject({ statusCode: 503 });
    expect(error.message).toMatch(/无法确认|待确认/);
    expect(error.message).not.toMatch(/已返还|已退回/);
    expect(console.error).toHaveBeenCalled();
    await expectState(user.id, 0, 0);
    expect(modelEvents("mock-ai.started")).toHaveLength(1);
  });

  it("A10: 同账号并发一成一败，返还不能覆盖另一次成功的扣减", async () => {
    const user = await createUser(2, "[fail] 写报告");
    let signalStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    vi.mocked(console.info).mockImplementation((line) => {
      if (typeof line === "string" && JSON.parse(line).event === "mock-ai.started") {
        signalStarted();
      }
    });

    // The first request has read the failing task and reserved its credit before
    // the real model logs started. Change the DB only after that exact point.
    const failedRequest = generatePlan({ hours: 8 }, contextFor(user)).catch((failure) => failure);
    await firstStarted;
    await prisma.task.updateMany({ where: { userId: user.id }, data: { description: "写报告" } });
    const [failure] = await Promise.all([
      failedRequest,
      generatePlan({ hours: 8 }, contextFor(user)),
    ]);

    expect(failure).toMatchObject({ statusCode: 502 });
    await expectState(user.id, 1, 1);
    expect(modelEvents("mock-ai.started")).toHaveLength(2);
    expect(modelEvents("mock-ai.failed")).toHaveLength(1);
    expect(modelEvents("mock-ai.succeeded")).toHaveLength(1);
  });

  it("A8: 未登录不调用模型", async () => {
    await expect(generatePlan({ hours: 8 }, contextFor(null)))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(modelEvents("mock-ai.started")).toHaveLength(0);
  });

  it("A8: 空待办不占额度、不调用模型", async () => {
    const user = await createUser(1, null);
    await expect(generatePlan({ hours: 8 }, contextFor(user)))
      .rejects.toMatchObject({ statusCode: 400 });
    await expectState(user.id, 1, 0);
    expect(modelEvents("mock-ai.started")).toHaveLength(0);
  });

  it.each([0, -1, 25, NaN, Infinity])("A8: 非法时长 %s 不占额度、不调用模型", async (hours) => {
    const user = await createUser(1);
    await expect(generatePlan({ hours }, contextFor(user)))
      .rejects.toMatchObject({ statusCode: 400 });
    await expectState(user.id, 1, 0);
    expect(modelEvents("mock-ai.started")).toHaveLength(0);
  });
});
