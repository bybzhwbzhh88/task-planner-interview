#!/usr/bin/env node
/**
 * 可重复执行的额度处理验证脚本，覆盖 SPEC.md 的 AC1–AC4。
 *
 * 前置条件：
 *   1. PostgreSQL 已运行且完成迁移（wasp db migrate-dev）。
 *   2. 应用已启动：wasp start（服务端默认监听 http://localhost:3001）。
 *   3. （可选）用 `wasp start 2>&1 | tee server.log` 启动并把日志路径传给
 *      --server-log，脚本会额外断言 mock-ai.started / succeeded / failed 次数。
 *
 * 用法：
 *   node scripts/verify-credits.mjs [--base-url http://localhost:3001] [--server-log server.log]
 *
 * 每个场景注册一个全新的测试账号（初始额度 3），互不干扰，可反复执行。
 * 任一断言失败即退出码 1，并打印失败明细。
 */

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const BASE_URL = opt("base-url", "http://localhost:3001");
const SERVER_LOG = opt("server-log", null);

import { readFile } from "node:fs/promises";

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✅" : "❌"} ${label}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`);
}

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    // Wasp operations 使用 superjson 传输：请求参数放在 { json: ... }，
    // 响应数据同样包一层 { json, meta }。
    body: body === undefined ? undefined : JSON.stringify({ json: body }),
  });
  let data = null;
  try {
    const envelope = await res.json();
    data = envelope && typeof envelope === "object" && "json" in envelope ? envelope.json : envelope;
  } catch {
    /* 无 JSON 响应体 */
  }
  return { status: res.status, data };
}

async function freshUser(tag) {
  const username = `verify${tag}${Date.now()}${Math.floor(Math.random() * 1e4)}`;
  const password = "password123";
  // 认证接口不走 superjson，直接收发普通 JSON。
  const authPost = async (path, body) => {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const signup = await authPost("/auth/username/signup", { username, password });
  if (signup.status >= 400) throw new Error(`signup 失败: ${JSON.stringify(signup)}`);
  const login = await authPost("/auth/username/login", { username, password });
  if (login.status !== 200 || !login.data?.sessionId) {
    throw new Error(`login 失败: ${JSON.stringify(login)}`);
  }
  return login.data.sessionId;
}

async function getCredits(token) {
  const me = await api("/auth/me", { token });
  if (me.status !== 200) throw new Error(`/auth/me 失败: ${JSON.stringify(me)}`);
  return me.data.credits;
}

const generate = (token) =>
  api("/operations/generate-plan", { method: "POST", token, body: { hours: 8 } });
const createTask = (token, description) =>
  api("/operations/create-task", { method: "POST", token, body: { description } });
const getPlanResultCount = async (token) => {
  const res = await api("/operations/get-plan-results", { method: "POST", token, body: {} });
  if (res.status !== 200 || !Array.isArray(res.data)) {
    throw new Error(`get-plan-results 失败: ${JSON.stringify(res)}`);
  }
  return res.data.length;
};

/** 读取服务器日志增量，统计三种 mock-ai 事件及其 callId。 */
async function logDelta(since) {
  if (!SERVER_LOG) return null;
  const content = await readFile(SERVER_LOG, "utf8");
  const fresh = content.slice(since);
  const events = { started: new Set(), succeeded: new Set(), failed: new Set() };
  for (const line of fresh.split("\n")) {
    const m = line.match(/\{"event":"(mock-ai\.\w+)","callId":"([^"]+)"\}/);
    if (m) events[m[1].slice(8)].add(m[2]);
  }
  return {
    started: events.started.size,
    succeeded: events.succeeded.size,
    failed: events.failed.size,
    sameCallId:
      events.started.size === 0 ||
      [...events.succeeded, ...events.failed].every((id) => events.started.has(id)),
  };
}
const logSize = async () =>
  SERVER_LOG ? (await readFile(SERVER_LOG, "utf8")).length : 0;

async function scenario(title, fn) {
  console.log(`\n=== ${title} ===`);
  try {
    await fn();
  } catch (err) {
    failures += 1;
    console.log(`  ❌ 场景执行异常: ${err.message}`);
  }
}

// AC1：成功生成消耗 1 额度
await scenario("AC1 成功生成：消耗 1 额度，模型调用成功", async () => {
  const token = await freshUser("ac1");
  await createTask(token, "写周报");
  const mark = await logSize();
  const res = await generate(token);
  check("HTTP 状态", res.status, 200);
  check("返回日程含任务", Array.isArray(res.data?.taskItems), true);
  check("剩余额度", await getCredits(token), 2);
  check("新增 PlanResult 数", await getPlanResultCount(token), 1);
  const log = await logDelta(mark);
  if (log) {
    check("mock-ai.started 次数", log.started, 1);
    check("mock-ai.succeeded 次数", log.succeeded, 1);
    check("同一 callId", log.sameCallId, true);
  }
});

// AC2：额度不足时不发起模型调用
await scenario("AC2 额度不足：返回 402 且不发起模型调用", async () => {
  const token = await freshUser("ac2");
  await createTask(token, "整理收件箱");
  for (let i = 0; i < 3; i += 1) {
    const ok = await generate(token);
    if (ok.status !== 200) throw new Error(`第 ${i + 1} 次生成应成功，实际 ${ok.status}`);
  }
  check("三次成功后额度归零", await getCredits(token), 0);
  const mark = await logSize();
  const res = await generate(token);
  check("第 4 次 HTTP 状态", res.status, 402);
  check("额度不变", await getCredits(token), 0);
  const log = await logDelta(mark);
  if (log) check("mock-ai.started 次数（未发起调用）", log.started, 0);
});

// AC3：模型明确失败时不消耗额度
await scenario("AC3 模型失败：返回 502，额度退还", async () => {
  const token = await freshUser("ac3");
  await createTask(token, "[fail] 触发失败");
  const mark = await logSize();
  const res = await generate(token);
  check("HTTP 状态", res.status, 502);
  check("额度不变（已退还）", await getCredits(token), 3);
  check("无新增 PlanResult", await getPlanResultCount(token), 0);
  const log = await logDelta(mark);
  if (log) {
    check("mock-ai.started 次数", log.started, 1);
    check("mock-ai.failed 次数", log.failed, 1);
    check("同一 callId", log.sameCallId, true);
  }
});

// AC4：并发请求不透支（10 并发 / 3 额度 → 恰好 3 成功）
await scenario("AC4 并发：10 个并发请求，恰好 3 个成功，无透支", async () => {
  const token = await freshUser("ac4");
  await createTask(token, "准备评审材料");
  const mark = await logSize();
  const results = await Promise.all(Array.from({ length: 10 }, () => generate(token)));
  const byStatus = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  状态分布: ${JSON.stringify(byStatus)}`);
  check("成功数", byStatus[200] ?? 0, 3);
  check("402 数", byStatus[402] ?? 0, 7);
  check("最终额度（不为负）", await getCredits(token), 0);
  check("新增 PlanResult 恰好 3 条", await getPlanResultCount(token), 3);
  const log = await logDelta(mark);
  if (log) check("mock-ai.started 恰好 3 次", log.started, 3);
});

console.log(failures === 0 ? "\n全部断言通过 ✅" : `\n共 ${failures} 条断言失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
