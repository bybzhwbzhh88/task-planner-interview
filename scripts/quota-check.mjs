#!/usr/bin/env node
// 额度行为验收脚本：只通过公开 HTTP 接口操作，不写数据库、不依赖测试后门。
//
// 用法（应用已在本地运行时）：
//   node scripts/quota-check.mjs
//   node scripts/quota-check.mjs --base http://localhost:3001 --log ~/wasp.log
//
// 每个场景都用新注册的账号（默认额度 3），因此可以反复执行。
// 传入 --log 时会额外比对 mock-ai.started 的增量，用于验证"额度不足时不调模型"。

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("--base", "http://localhost:3001").replace(/\/$/, "");
const LOG = argOf("--log", null);
const DEFAULT_CREDITS = 3;

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

// Wasp 的 operations 路由使用 superjson 包装请求体与响应体。
async function call(path, { body, sessionId, method = "POST", raw } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(sessionId ? { Authorization: `Bearer ${sessionId}` } : {}),
    },
    body:
      body === undefined
        ? undefined
        : JSON.stringify(raw ? body : { json: body }),
  });
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: res.status, payload };
}

async function newSession() {
  const username = `quota-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const password = "pass12345";
  // 认证路由用普通 JSON，不走 operations 的 superjson 包装。
  await call("/auth/username/signup", {
    body: { username, password },
    raw: true,
  });
  const login = await call("/auth/username/login", {
    body: { username, password },
    raw: true,
  });
  const sessionId = login.payload?.sessionId ?? login.payload?.json?.sessionId;
  if (!sessionId) {
    throw new Error(`登录失败: ${JSON.stringify(login.payload)}`);
  }
  return { username, sessionId };
}

const createTask = (sid, description) =>
  call("/operations/create-task", { sessionId: sid, body: { description } });

const generatePlan = (sid) =>
  call("/operations/generate-plan", { sessionId: sid, body: { hours: 8 } });

// 查询接口同样是 POST，无参时请求体是 {"json":null}
const runQuery = async (sid, name) => {
  const res = await call(`/operations/${name}`, { sessionId: sid, body: null });
  return res.payload?.json;
};

const getCredits = (sid) => runQuery(sid, "get-my-credits");

const message = (res) =>
  res.payload?.json?.message ?? res.payload?.json ?? JSON.stringify(res.payload);

// 统计日志中 mock-ai.started 的条数；未提供 --log 时返回 null（跳过断言）。
function startedCount() {
  if (!LOG) return null;
  const text = readFileSync(LOG, "utf8");
  return (text.match(/"event":"mock-ai\.started"/g) || []).length;
}

// 一次成功后额度应减 1
async function spend(sid, times) {
  for (let i = 0; i < times; i++) {
    const res = await generatePlan(sid);
    if (res.status !== 200) throw new Error(`预热失败: ${res.status}`);
  }
}

async function ac1() {
  const { sessionId } = await newSession();
  await createTask(sessionId, "写周报");
  const before = startedCount();
  const res = await generatePlan(sessionId);
  const after = startedCount();
  const credits = await getCredits(sessionId);
  check("AC1 返回日程", res.status === 200 && !!res.payload?.json?.schedule);
  check("AC1 返回剩余额度 2", res.payload?.json?.creditsRemaining === 2,
    `creditsRemaining=${res.payload?.json?.creditsRemaining}`);
  check("AC1 余额 3→2", credits === 2, `credits=${credits}`);
  if (before !== null) {
    check("AC1 恰好 1 次模型调用", after - before === 1, `增量=${after - before}`);
  }
}

async function ac2() {
  const { sessionId } = await newSession();
  await createTask(sessionId, "写周报");
  await spend(sessionId, DEFAULT_CREDITS); // 3 次成功后额度归零
  const before = startedCount();
  const res = await generatePlan(sessionId);
  const after = startedCount();
  const credits = await getCredits(sessionId);
  check("AC2 返回 402", res.status === 402, `status=${res.status}`);
  check("AC2 余额仍为 0", credits === 0, `credits=${credits}`);
  if (before !== null) {
    check("AC2 未调用模型", after - before === 0, `增量=${after - before}`);
  }
  console.log(`      402 文案: ${message(res)}`);
}

async function ac3() {
  const { sessionId } = await newSession();
  await createTask(sessionId, "[fail] 让模型失败");
  const before = startedCount();
  const res = await generatePlan(sessionId);
  const after = startedCount();
  const credits = await getCredits(sessionId);
  const results = await runQuery(sessionId, "get-plan-results");
  check("AC3 返回 5xx", res.status >= 500, `status=${res.status}`);
  check("AC3 额度未扣", credits === DEFAULT_CREDITS, `credits=${credits}`);
  check("AC3 未写入 PlanResult", results?.length === 0, `条数=${results?.length}`);
  if (before !== null) {
    check("AC3 模型确实被调用过 1 次", after - before === 1, `增量=${after - before}`);
  }
  console.log(`      5xx 文案: ${message(res)}`);

  // AC6：移除失败任务后重试应成功并扣 1
  const tasks = await runQuery(sessionId, "get-all-tasks-by-user");
  const failTask = tasks?.[0];
  await call("/operations/delete-task", {
    sessionId,
    body: { id: failTask.id },
  });
  await createTask(sessionId, "正常任务");
  const retry = await generatePlan(sessionId);
  const creditsAfterRetry = await getCredits(sessionId);
  check("AC6 重试成功", retry.status === 200, `status=${retry.status}`);
  check("AC6 重试后额度 3→2", creditsAfterRetry === 2, `credits=${creditsAfterRetry}`);
}

async function concurrent(label, initialLeft) {
  const { sessionId } = await newSession();
  await createTask(sessionId, "写周报");
  await spend(sessionId, DEFAULT_CREDITS - initialLeft);
  const before = startedCount();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => generatePlan(sessionId)),
  );
  const after = startedCount();
  const codes = results.map((r) => r.status);
  const ok = codes.filter((c) => c === 200).length;
  const denied = codes.filter((c) => c === 402).length;
  const credits = await getCredits(sessionId);
  check(`${label} 成功数 = 初始额度 ${initialLeft}`, ok === initialLeft,
    `状态码=${codes.join(",")}`);
  check(`${label} 其余全部 402`, denied === 5 - initialLeft, `402 数=${denied}`);
  check(`${label} 余额不为负`, credits === 0, `credits=${credits}`);
  if (before !== null) {
    check(`${label} 模型调用数 = 成功数`, after - before === initialLeft,
      `增量=${after - before}`);
  }
}

console.log(`目标: ${BASE}${LOG ? `  日志: ${LOG}` : "  （未提供 --log，跳过调用计数断言）"}`);
console.log("");

await ac1();
await ac2();
await ac3();
await concurrent("AC4", 1);
await concurrent("AC5", 3);

console.log("");
if (failures.length) {
  console.log(`失败 ${failures.length} 项: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("全部通过");
