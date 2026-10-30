import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const baseUrl = "http://localhost:3001";

async function request(path, body, sessionId) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionId
        ? { Authorization: `Bearer ${sessionId}` }
        : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`接口未返回 JSON：${path}，状态 ${response.status}`);
  }

  return { status: response.status, data };
}

// Wasp 的操作接口使用 { json: 参数 } 格式。
async function operation(name, args, sessionId) {
  return request(`/operations/${name}`, { json: args }, sessionId);
}

async function readOperation(name, sessionId) {
  const result = await operation(name, {}, sessionId);
  assert.equal(result.status, 200, `${name} 查询失败`);
  return result.data.json;
}

async function createAccount(label) {
  const username = `quota_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const password = `Test-${randomUUID()}!`;
  const credentials = { username, password };

  const signup = await request("/auth/username/signup", credentials);
  assert.equal(signup.status, 200, "注册测试账号失败");

  const login = await request("/auth/username/login", credentials);
  assert.equal(login.status, 200, "登录测试账号失败");
  assert.ok(login.data.sessionId, "未返回登录会话");

  const sessionId = login.data.sessionId;
  const task = await operation(
    "create-task",
    { description: "额度验证任务" },
    sessionId,
  );
  assert.equal(task.status, 200, "创建任务失败");

  console.log(`测试账号（${label}）：${username}`);
  assert.equal(await readOperation("get-credits", sessionId), 3);

  return sessionId;
}

async function assertState(sessionId, expectedCredits, expectedResults) {
  const credits = await readOperation("get-credits", sessionId);
  const results = await readOperation("get-plan-results", sessionId);

  assert.equal(credits, expectedCredits, "剩余额度不符合预期");
  assert.equal(results.length, expectedResults, "保存的日程数量不符合预期");
}

async function generate(sessionId) {
  return operation("generate-plan", { hours: 8 }, sessionId);
}

async function assertConcurrent(sessionId, expectedSuccesses) {
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => generate(sessionId)),
  );

  const statuses = responses.map((result) => result.status);
  assert.equal(
    statuses.filter((status) => status === 200).length,
    expectedSuccesses,
    `成功数量异常：${statuses.join(", ")}`,
  );
  assert.equal(
    statuses.filter((status) => status === 402).length,
    5 - expectedSuccesses,
    `拦截数量异常：${statuses.join(", ")}`,
  );

  console.log(`并发响应：${statuses.join(", ")}`);
}

async function main() {
  const sessionId = await createAccount("成功、失败与余额为 1 的并发");

  const success = await generate(sessionId);
  assert.equal(success.status, 200);
  await assertState(sessionId, 2, 1);
  console.log("PASS：成功生成后，额度 3 → 2，新增 1 条日程");

  const failedTask = await operation(
    "create-task",
    { description: "[fail] 验证失败不扣额度" },
    sessionId,
  );
  assert.equal(failedTask.status, 200);

  const failed = await generate(sessionId);
  assert.equal(failed.status, 500);
  await assertState(sessionId, 2, 1);
  console.log("PASS：模型明确失败，额度仍为 2，没有新增日程");

  const deleted = await operation(
    "delete-task",
    { id: failedTask.data.json.id },
    sessionId,
  );
  assert.equal(deleted.status, 200);

  assert.equal((await generate(sessionId)).status, 200);
  await assertState(sessionId, 1, 2);

  await assertConcurrent(sessionId, 1);
  await assertState(sessionId, 0, 3);
  console.log("PASS：额度为 1，同时请求 5 次，仅成功 1 次，无透支");

  const noCredits = await generate(sessionId);
  assert.equal(noCredits.status, 402);
  await assertState(sessionId, 0, 3);
  console.log("PASS：零额度直接请求返回 402，额度和日程数不变");

  const secondSession = await createAccount("余额为 3 的并发");
  await assertConcurrent(secondSession, 3);
  await assertState(secondSession, 0, 3);
  console.log("PASS：额度为 3，同时请求 5 次，仅成功 3 次，无透支");

  console.log("全部脚本断言通过。");
  console.log("请另行核对服务端 mock-ai.started 日志：本轮应新增 7 次调用。");
}

main().catch((error) => {
  console.error("FAIL：", error);
  process.exitCode = 1;
});