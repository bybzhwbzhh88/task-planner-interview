import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CreditRefundError,
  generatePlanWithQuota,
  InsufficientCreditsError,
  ModelRejectedError,
  type CreditReservation,
  type PlanRepository,
  type PlanTask,
  type ScheduleGenerator,
} from "../src/demo-ai-app/generate-plan.ts";
import {
  generateMockSchedule,
  MOCK_AI_REJECTED_CODE,
} from "../src/demo-ai-app/mockAi.ts";
import type { GeneratedSchedule } from "../src/demo-ai-app/schedule.ts";

/**
 * In-memory stand-in for the Prisma adapter.
 *
 * `reserveCredit` has no await between reading and writing `credits`, which is
 * how the production guarded UPDATE behaves: the database serializes the
 * predicate check and the decrement in one statement.
 */
class MemoryPlanRepository implements PlanRepository {
  credits: number;
  plans: string[] = [];
  refunds = 0;
  failListTasks = false;
  failSave = false;
  failRefund = false;

  constructor(credits: number) {
    this.credits = credits;
  }

  async listTasks(_userId: string): Promise<PlanTask[]> {
    if (this.failListTasks) {
      throw new Error("task query failed");
    }
    return [{ description: "写周报", time: "1" }];
  }

  async reserveCredit(_userId: string): Promise<CreditReservation> {
    if (this.credits <= 0) {
      return { ok: false, remainingCredits: this.credits };
    }
    this.credits -= 1;
    return { ok: true, remainingCredits: this.credits };
  }

  async refundCredit(_userId: string): Promise<void> {
    this.credits += 1;
    this.refunds += 1;
    if (this.failRefund) {
      throw new Error("refund write failed");
    }
  }

  async savePlanResult(_userId: string, content: string): Promise<void> {
    if (this.failSave) {
      throw new Error("plan write failed");
    }
    this.plans.push(content);
  }
}

function scheduleFor(tasks: PlanTask[]): GeneratedSchedule {
  return {
    tasks: tasks.map((task) => ({
      name: task.description,
      priority: "medium" as const,
    })),
    taskItems: tasks.map((task) => ({
      description: `执行: ${task.description}`,
      taskName: task.description,
      time: 1,
    })),
  };
}

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return {
    promise,
    resolve: () => resolve?.(),
  };
}

const userId = "user-1";

test("AC-01 成功：预占 1 个额度、保存结果并返回剩余额度", async () => {
  const repo = new MemoryPlanRepository(3);

  const result = await generatePlanWithQuota(
    { userId, hours: 8 },
    { repo, generateSchedule: async (tasks) => scheduleFor(tasks) },
  );

  assert.equal(result.remainingCredits, 2);
  assert.equal(repo.credits, 2);
  assert.equal(repo.plans.length, 1);
  assert.equal(repo.refunds, 0);
  assert.equal(JSON.parse(repo.plans[0]!).tasks[0].name, "写周报");
  assert.equal(result.schedule.taskItems[0].taskName, "写周报");
});

test("AC-02 额度不足：不调用模型、不保存、不改变余额", async () => {
  const repo = new MemoryPlanRepository(0);
  let modelCalls = 0;
  const generateSchedule: ScheduleGenerator = async (tasks) => {
    modelCalls += 1;
    return scheduleFor(tasks);
  };

  await assert.rejects(
    generatePlanWithQuota({ userId, hours: 8 }, { repo, generateSchedule }),
    InsufficientCreditsError,
  );

  assert.equal(modelCalls, 0);
  assert.equal(repo.plans.length, 0);
  assert.equal(repo.credits, 0);
  assert.equal(repo.refunds, 0);
});

test("AC-03 模型明确失败：退回额度并映射为 ModelRejectedError", async () => {
  const repo = new MemoryPlanRepository(2);
  const providerError = Object.assign(new Error("explicit rejection"), {
    code: "MOCK_AI_REJECTED",
  });

  await assert.rejects(
    generatePlanWithQuota(
      { userId, hours: 8 },
      {
        repo,
        generateSchedule: async () => {
          throw providerError;
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ModelRejectedError);
      assert.equal(error.code, "MODEL_REJECTED");
      assert.equal(error.providerError, providerError);
      return true;
    },
  );

  assert.equal(repo.credits, 2);
  assert.equal(repo.refunds, 1);
  assert.equal(repo.plans.length, 0);
});

test("AC-04 并发争抢最后 1 个额度：只成功 1 个、只调用 1 次模型", async () => {
  const repo = new MemoryPlanRepository(1);
  const modelGate = deferred();
  const modelStarted = deferred();
  let modelCalls = 0;

  const generateSchedule: ScheduleGenerator = async (tasks) => {
    modelCalls += 1;
    modelStarted.resolve();
    await modelGate.promise;
    return scheduleFor(tasks);
  };

  // All five calls reserve before any await resumes; only the first can win.
  const requests = Array.from({ length: 5 }, () =>
    generatePlanWithQuota({ userId, hours: 8 }, { repo, generateSchedule }),
  );

  await modelStarted.promise;
  modelGate.resolve();
  const results = await Promise.allSettled(requests);

  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 4);
  for (const result of rejected) {
    assert.ok(result.reason instanceof InsufficientCreditsError);
  }
  assert.equal(modelCalls, 1);
  assert.equal(repo.plans.length, 1);
  assert.equal(repo.credits, 0);
});

test("AC-05 结果保存失败：退回额度，不留下结果", async () => {
  const repo = new MemoryPlanRepository(2);
  repo.failSave = true;

  await assert.rejects(
    generatePlanWithQuota(
      { userId, hours: 8 },
      { repo, generateSchedule: async (tasks) => scheduleFor(tasks) },
    ),
    /plan write failed/,
  );

  assert.equal(repo.credits, 2);
  assert.equal(repo.refunds, 1);
  assert.equal(repo.plans.length, 0);
});

test("退款失败会单独暴露，避免静默吞掉用户损失", async () => {
  const repo = new MemoryPlanRepository(1);
  repo.failRefund = true;

  await assert.rejects(
    generatePlanWithQuota(
      { userId, hours: 8 },
      {
        repo,
        generateSchedule: async () => {
          throw Object.assign(new Error("explicit rejection"), {
            code: "MOCK_AI_REJECTED",
          });
        },
      },
    ),
    CreditRefundError,
  );
});

function captureConsoleInfo() {
  const original = console.info;
  const lines: string[] = [];
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.info = original;
    },
  };
}

function parseEvents(lines: string[]) {
  return lines.map(
    (line) => JSON.parse(line) as { event: string; callId: string },
  );
}

test("mockAi 成功时 started/succeeded 成对，callId 一致", async () => {
  const capture = captureConsoleInfo();
  let schedule: GeneratedSchedule | undefined;
  try {
    schedule = await generateMockSchedule(
      [{ description: "写周报", time: "1" }],
      8,
    );
  } finally {
    capture.restore();
  }

  const events = parseEvents(capture.lines);
  assert.deepEqual(
    events.map((event) => event.event),
    ["mock-ai.started", "mock-ai.succeeded"],
  );
  assert.equal(events[0].callId, events[1].callId);
  assert.equal(schedule?.tasks[0].name, "写周报");
});

test("mockAi 明确失败时抛出 MOCK_AI_REJECTED，日志为 started/failed", async () => {
  const capture = captureConsoleInfo();
  let thrown: unknown;
  try {
    await assert.rejects(
      generateMockSchedule([{ description: "[fail] 写周报", time: "1" }], 8),
      (error: unknown) => {
        thrown = error;
        return true;
      },
    );
  } finally {
    capture.restore();
  }

  assert.equal((thrown as { code?: string }).code, MOCK_AI_REJECTED_CODE);
  const events = parseEvents(capture.lines);
  assert.deepEqual(
    events.map((event) => event.event),
    ["mock-ai.started", "mock-ai.failed"],
  );
  assert.equal(events[0].callId, events[1].callId);
});

test("真实 mockAi + 5 并发：只有 1 次 mock-ai.started", async () => {
  const repo = new MemoryPlanRepository(1);
  const capture = captureConsoleInfo();
  let results: PromiseSettledResult<unknown>[] = [];
  try {
    results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        generatePlanWithQuota(
          { userId, hours: 8 },
          { repo, generateSchedule: generateMockSchedule },
        ),
      ),
    );
  } finally {
    capture.restore();
  }

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    4,
  );

  const events = parseEvents(capture.lines);
  assert.equal(
    events.filter((event) => event.event === "mock-ai.started").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.event === "mock-ai.succeeded").length,
    1,
  );
  assert.equal(repo.plans.length, 1);
  assert.equal(repo.credits, 0);
});

test("模型返回空结果：退款并失败，不保存空日程", async () => {
  const repo = new MemoryPlanRepository(2);

  await assert.rejects(
    generatePlanWithQuota(
      { userId, hours: 8 },
      {
        repo,
        generateSchedule: async () => null as unknown as GeneratedSchedule,
      },
    ),
    /returned no schedule/,
  );

  assert.equal(repo.credits, 2);
  assert.equal(repo.refunds, 1);
  assert.equal(repo.plans.length, 0);
});

test("5 并发、3 个额度：恰好 3 个成功，2 个额度不足", async () => {
  const repo = new MemoryPlanRepository(3);
  let modelCalls = 0;
  const generateSchedule: ScheduleGenerator = async (tasks) => {
    modelCalls += 1;
    return scheduleFor(tasks);
  };

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      generatePlanWithQuota({ userId, hours: 8 }, { repo, generateSchedule }),
    ),
  );

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    3,
  );
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(rejected.length, 2);
  for (const result of rejected) {
    assert.ok(result.reason instanceof InsufficientCreditsError);
  }
  assert.equal(modelCalls, 3);
  assert.equal(repo.plans.length, 3);
  assert.equal(repo.credits, 0);
});

test("读取任务失败：退回额度，不调用模型", async () => {
  const repo = new MemoryPlanRepository(2);
  repo.failListTasks = true;
  let modelCalls = 0;

  await assert.rejects(
    generatePlanWithQuota(
      { userId, hours: 8 },
      {
        repo,
        generateSchedule: async (tasks) => {
          modelCalls += 1;
          return scheduleFor(tasks);
        },
      },
    ),
    /task query failed/,
  );

  assert.equal(modelCalls, 0);
  assert.equal(repo.credits, 2);
  assert.equal(repo.refunds, 1);
});
