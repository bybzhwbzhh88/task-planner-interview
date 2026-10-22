/*
 * 原型额度逻辑测试。
 *
 * 运行：node product/prototype/quota-model.test.mjs
 *
 * 这不是后端集成测试；它验证原型使用的“同步预扣 + 失败退款”模型，
 * 用来在评审阶段证明规则自洽。真实数据库并发仍按 ACCEPTANCE 的 E-AC 执行。
 */
import assert from "node:assert/strict";
import "./quota-model.js";

const {
  QuotaStore,
  attemptGeneration,
  simulateConcurrentRequests,
  resetCallSequence,
} = globalThis.QuotaModel;

const tasks = [{ id: "t1", description: "写周报", time: 1, done: false }];
let passed = 0;

function ok(name, detail = "") {
  passed += 1;
  console.log(`PASS  ${name}${detail ? " — " + detail : ""}`);
}

function countEvents(events, type) {
  return events.filter((event) => event.type === type).length;
}

async function testConcurrentOneCredit() {
  resetCallSequence();
  let calls = 0;
  const events = [];
  const provider = async () => {
    calls += 1;
    return { tasks: [], taskItems: [] };
  };

  const result = await simulateConcurrentRequests({
    credits: 1,
    requestCount: 3,
    tasks,
    provider,
    onEvent: (event) => events.push(event),
  });

  const succeeded = result.results.filter((item) => item.status === "success");
  const insufficient = result.results.filter((item) => item.status === "insufficient");

  assert.equal(succeeded.length, 1, "恰好 1 个成功");
  assert.equal(insufficient.length, 2, "恰好 2 个额度不足");
  assert.equal(result.credits, 0, "最终余额为 0");
  assert.equal(calls, 1, "模型只调用 1 次");
  assert.equal(countEvents(events, "mock-ai.started"), 1, "只有 1 次 started");
  assert.equal(countEvents(events, "credit.insufficient"), 2, "2 次额度不足事件");
  assert.ok(result.credits >= 0, "余额不为负");

  ok(
    "1 额度 / 3 并发",
    `1 成功，2 不足，余额 ${result.credits}，模型调用 ${calls} 次`,
  );
}

async function testConcurrentThreeCredits() {
  resetCallSequence();
  let calls = 0;
  const provider = async () => {
    calls += 1;
    return { tasks: [], taskItems: [] };
  };

  const result = await simulateConcurrentRequests({
    credits: 3,
    requestCount: 5,
    tasks,
    provider,
    staggerMs: 30,
  });

  const succeeded = result.results.filter((item) => item.status === "success");
  const insufficient = result.results.filter((item) => item.status === "insufficient");
  const reservedBalances = succeeded
    .map((item) => item.remainingAtReserve)
    .sort((a, b) => a - b);

  assert.equal(succeeded.length, 3, "恰好 3 个成功");
  assert.equal(insufficient.length, 2, "恰好 2 个额度不足");
  assert.equal(result.credits, 0, "最终余额为 0");
  assert.equal(calls, 3, "模型调用 3 次");
  assert.deepEqual(reservedBalances, [0, 1, 2], "3 个成功请求预扣后余额为 0/1/2");

  ok(
    "3 额度 / 5 并发",
    `3 成功，2 不足，余额 ${result.credits}，模型调用 ${calls} 次`,
  );
}

async function testModelFailureRefunds() {
  resetCallSequence();
  let calls = 0;
  const events = [];
  const provider = async () => {
    calls += 1;
    throw new Error("Mock provider explicitly rejected the request");
  };

  const store = new QuotaStore(1);
  const result = await attemptGeneration(store, {
    tasks,
    provider,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.status, "failed", "状态为 failed");
  assert.equal(store.credits, 1, "失败后余额恢复为 1");
  assert.equal(result.remaining, 1, "返回余额为 1");
  assert.equal(calls, 1, "模型调用 1 次");
  assert.equal(countEvents(events, "mock-ai.started"), 1, "有 started");
  assert.equal(countEvents(events, "mock-ai.failed"), 1, "有 failed");
  assert.equal(countEvents(events, "credit.refunded"), 1, "有退款事件");

  ok("模型失败退款", `余额恢复 ${store.credits}，未形成扣费`);
}

async function testNoCreditDoesNotCallProvider() {
  resetCallSequence();
  let calls = 0;
  const events = [];
  const provider = async () => {
    calls += 1;
    return { tasks: [], taskItems: [] };
  };

  const store = new QuotaStore(0);
  const result = await attemptGeneration(store, {
    tasks,
    provider,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.status, "insufficient", "状态为 insufficient");
  assert.equal(calls, 0, "模型 0 调用");
  assert.equal(store.credits, 0, "余额保持 0");
  assert.equal(countEvents(events, "mock-ai.started"), 0, "没有 started");
  assert.equal(countEvents(events, "credit.insufficient"), 1, "有额度不足事件");

  ok("0 额度不调用模型", `余额 ${store.credits}，模型调用 ${calls} 次`);
}

async function testSequentialExhaustion() {
  resetCallSequence();
  let calls = 0;
  const provider = async () => {
    calls += 1;
    return { tasks: [], taskItems: [] };
  };
  const store = new QuotaStore(3);
  const statuses = [];

  for (let i = 0; i < 4; i += 1) {
    const result = await attemptGeneration(store, { tasks, provider });
    statuses.push(result.status);
  }

  assert.deepEqual(
    statuses,
    ["success", "success", "success", "insufficient"],
    "前 3 次成功，第 4 次不足",
  );
  assert.equal(store.credits, 0, "最终余额 0");
  assert.equal(calls, 3, "模型调用 3 次");

  ok("连续生成耗尽", `状态序列 ${statuses.join(" → ")}，余额 ${store.credits}`);
}

async function main() {
  console.log("额度原型逻辑测试");
  console.log("=".repeat(56));

  await testConcurrentOneCredit();
  await testConcurrentThreeCredits();
  await testModelFailureRefunds();
  await testNoCreditDoesNotCallProvider();
  await testSequentialExhaustion();

  console.log("=".repeat(56));
  console.log(`全部通过：${passed} 组场景`);
}

main().catch((error) => {
  console.error("FAIL");
  console.error(error);
  process.exitCode = 1;
});
