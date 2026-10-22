#!/usr/bin/env node
/**
 * 额度处理的可重复验收脚本，对应 SPEC.md §7 的 AC-01 ~ AC-08 与 AC-13。
 *
 * 用法（Wasp dev server 已启动，且日志写到了文件里）:
 *   node scripts/verify-quota.mjs
 *   node scripts/verify-quota.mjs --base-url http://127.0.0.1:3001 --log /tmp/wasp-dev.log
 *
 * 设计说明：
 * - 只用 Node 内置 fetch，不引入新依赖。
 * - 每个场景建一个全新账号（初始 3 额度），互不干扰；用完后数据留在开发库里，不影响断言。
 * - `mock-ai.started` 的条数直接从 server 日志里数，因为 TASK 指定它是"已发起调用"的证据。
 *     日志不可读时该项标 SKIP，不伪装成通过。
 */

import { readFile } from "node:fs/promises";

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const BASE_URL = argOf("--base-url", process.env.BASE_URL ?? "http://127.0.0.1:3001");
const LOG_PATH = argOf("--log", process.env.WASP_LOG ?? "/tmp/wasp-dev.log");

/**
 * 一次 HTTP 调用，返回状态码、解包后的 body 和耗时。
 *
 * Wasp 的 `/operations/*` 走 serialize/deserialize，请求体需要包成 `{ json: args }`；
 * 而 `/auth/*` 是普通 express 路由，直接读 `req.body`。用 `wrap` 区分这两种。
 */
async function call(path, { token, args, wrap = true } = {}) {
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (args !== undefined) headers["Content-Type"] = "application/json";

  const startedAt = performance.now();
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body:
      args === undefined
        ? undefined
        : JSON.stringify(wrap ? { json: args } : args),
  });
  const elapsedMs = performance.now() - startedAt;

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  // Wasp 把成功结果包成 { json, meta }，错误则是 { message, data }。
  return { status: response.status, body: parsed?.json ?? parsed, elapsedMs };
}

/** server 日志里某个 event 出现的次数；日志不可读时返回 null。 */
async function eventCount(event) {
  try {
    const text = await readFile(LOG_PATH, "utf8");
    const needle = `"event":"${event}"`;
    return text.split(needle).length - 1;
  } catch {
    return null;
  }
}

const results = [];
function check(id, assertion, ok, detail) {
  results.push({ id, assertion, ok, detail });
  const mark = ok === null ? "SKIP" : ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${id} ${assertion}${detail ? ` — ${detail}` : ""}`);
}

let userSeq = 0;
async function newSession(prefix) {
  const username = `${prefix}_${Date.now().toString(36)}_${++userSeq}`;
  const password = "password123";
  await call("/auth/username/signup", { args: { username, password }, wrap: false });
  const login = await call("/auth/username/login", {
    args: { username, password },
    wrap: false,
  });
  const token = login.body?.sessionId;
  if (!token) throw new Error(`login failed for ${username}: ${JSON.stringify(login.body)}`);
  return { username, token };
}

const balanceOf = async (token) =>
  (await call("/operations/get-credit-balance", { token, args: {} })).body?.credits;
const planCountOf = async (token) =>
  (await call("/operations/get-plan-results", { token, args: {} })).body?.length;
const createTask = (token, description) =>
  call("/operations/create-task", { token, args: { description } });
const deleteTask = (token, id) =>
  call("/operations/delete-task", { token, args: { id } });
const tasksOf = async (token) =>
  (await call("/operations/get-all-tasks-by-user", { token, args: {} })).body ?? [];
const generate = (token, hours = 8) =>
  call("/operations/generate-plan", { token, args: { hours } });

async function main() {
  console.log(`base=${BASE_URL}  log=${LOG_PATH}\n`);

  // ---- AC-01 成功一次扣 1 -------------------------------------------------
  {
    const session = await newSession("ac01");
    await createTask(session.token, "写周报");
    const startedBefore = await eventCount("mock-ai.started");

    const result = await generate(session.token);
    const balance = await balanceOf(session.token);
    const startedAfter = await eventCount("mock-ai.started");

    check(
      "AC-01",
      "生成成功并返回 creditsRemaining=2",
      result.status === 200 && result.body?.creditsRemaining === 2,
      `http=${result.status} creditsRemaining=${result.body?.creditsRemaining} ${result.elapsedMs.toFixed(0)}ms`,
    );
    check("AC-01", "库内余额为 2", balance === 2, `balance=${balance}`);
    check("AC-01", "PlanResult 新增 1 条", (await planCountOf(session.token)) === 1);
    check(
      "AC-01",
      "mock-ai.started 增加 1 条",
      startedBefore === null ? null : startedAfter - startedBefore === 1,
      startedBefore === null ? "日志不可读" : `${startedBefore} -> ${startedAfter}`,
    );
  }

  // ---- AC-02 连续用尽 / AC-03 额度不足不发起调用 --------------------------
  {
    const session = await newSession("ac02");
    await createTask(session.token, "整理需求");
    const startedBefore = await eventCount("mock-ai.started");

    const remaining = [];
    for (let i = 0; i < 3; i++) {
      const result = await generate(session.token);
      remaining.push(result.body?.creditsRemaining);
    }
    const startedAfter = await eventCount("mock-ai.started");
    const fourth = await generate(session.token);

    check(
      "AC-02",
      "连续 3 次余额依次为 2/1/0",
      JSON.stringify(remaining) === "[2,1,0]",
      `remaining=${JSON.stringify(remaining)}`,
    );
    check(
      "AC-02",
      "第 4 次返回 402",
      fourth.status === 402,
      `http=${fourth.status}`,
    );
    check("AC-02", "PlanResult 共 3 条", (await planCountOf(session.token)) === 3);
    check(
      "AC-02",
      "3 次成功对应 3 条 mock-ai.started",
      startedBefore === null ? null : startedAfter - startedBefore === 3,
      startedBefore === null ? "日志不可读" : `${startedBefore} -> ${startedAfter}`,
    );

    // AC-03：此时余额已为 0
    const balanceBefore = await balanceOf(session.token);
    const startedBeforeRetry = await eventCount("mock-ai.started");
    const rejected = await generate(session.token);
    const startedAfterRetry = await eventCount("mock-ai.started");

    check(
      "AC-03",
      "0 额度时返回 402",
      rejected.status === 402,
      `http=${rejected.status} body=${JSON.stringify(rejected.body)}`,
    );
    check(
      "AC-03",
      "不发起模型调用：耗时明显低于 500ms 模拟延迟",
      rejected.elapsedMs < 100,
      `${rejected.elapsedMs.toFixed(0)}ms（成功请求约 500ms）`,
    );
    check(
      "AC-03",
      "mock-ai.started 不增加",
      startedBeforeRetry === null ? null : startedAfterRetry === startedBeforeRetry,
      startedBeforeRetry === null
        ? "日志不可读"
        : `${startedBeforeRetry} -> ${startedAfterRetry}`,
    );
    check(
      "AC-03",
      "余额保持 0，未写 PlanResult",
      (await balanceOf(session.token)) === 0 && (await planCountOf(session.token)) === 3,
      `balance=${balanceBefore}`,
    );
  }

  // ---- AC-04 模型失败不扣额度 / AC-05 失败后可重试 ------------------------
  {
    const session = await newSession("ac04");
    await createTask(session.token, "写周报");
    await createTask(session.token, "[fail] 演示失败");
    const balanceBefore = await balanceOf(session.token);
    const startedBefore = await eventCount("mock-ai.started");
    const failedBefore = await eventCount("mock-ai.failed");

    const failed = await generate(session.token);
    const startedAfter = await eventCount("mock-ai.started");
    const failedAfter = await eventCount("mock-ai.failed");

    check(
      "AC-04",
      "模型失败返回 502",
      failed.status === 502,
      `http=${failed.status} body=${JSON.stringify(failed.body)}`,
    );
    check(
      "AC-04",
      "余额不变（已退还）",
      (await balanceOf(session.token)) === balanceBefore,
      `before=${balanceBefore} after=${await balanceOf(session.token)}`,
    );
    check("AC-04", "未写 PlanResult", (await planCountOf(session.token)) === 0);
    check(
      "AC-04",
      "started +1 且 failed +1",
      startedBefore === null || failedBefore === null
        ? null
        : startedAfter - startedBefore === 1 && failedAfter - failedBefore === 1,
      startedBefore === null ? "日志不可读" : `${startedBefore}->${startedAfter}`,
    );

    const failTask = (await tasksOf(session.token)).find((task) =>
      task.description.includes("[fail]"),
    );
    await deleteTask(session.token, failTask.id);
    const retried = await generate(session.token);

    check(
      "AC-05",
      "移除失败任务后重试成功并扣 1",
      retried.status === 200 && (await balanceOf(session.token)) === balanceBefore - 1,
      `http=${retried.status} balance=${await balanceOf(session.token)}`,
    );
  }

  // ---- AC-06 并发 10 个 / 3 额度 ------------------------------------------
  {
    const session = await newSession("ac06");
    await createTask(session.token, "并发测试");
    const startedBefore = await eventCount("mock-ai.started");

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => generate(session.token)),
    );
    const statuses = responses.map((response) => response.status);
    const startedAfter = await eventCount("mock-ai.started");
    const balance = await balanceOf(session.token);

    check("AC-06", "余额正好 0（不为负）", balance === 0, `balance=${balance}`);
    check("AC-06", "PlanResult 正好 3 条", (await planCountOf(session.token)) === 3);
    check(
      "AC-06",
      "mock-ai.started 正好 3 条",
      startedBefore === null ? null : startedAfter - startedBefore === 3,
      startedBefore === null ? "日志不可读" : `${startedBefore} -> ${startedAfter}`,
    );
    check(
      "AC-06",
      "10 个请求中 3 个成功、7 个 402",
      statuses.filter((s) => s === 200).length === 3 &&
        statuses.filter((s) => s === 402).length === 7,
      `statuses=${JSON.stringify(statuses)}`,
    );
  }

  // ---- AC-07 并发 5 个 / 剩 1 额度 ----------------------------------------
  {
    const session = await newSession("ac07");
    await createTask(session.token, "并发测试二");
    await generate(session.token);
    await generate(session.token);
    const balanced = await balanceOf(session.token);
    const startedBefore = await eventCount("mock-ai.started");

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => generate(session.token)),
    );
    const statuses = responses.map((response) => response.status);
    const startedAfter = await eventCount("mock-ai.started");
    const balance = await balanceOf(session.token);

    check("AC-07", "预置余额为 1", balanced === 1, `balance=${balanced}`);
    check("AC-07", "余额正好 0（不为负）", balance === 0, `balance=${balance}`);
    check("AC-07", "PlanResult 只多了 1 条", (await planCountOf(session.token)) === 3);
    check(
      "AC-07",
      "mock-ai.started 只多 1 条",
      startedBefore === null ? null : startedAfter - startedBefore === 1,
      startedBefore === null ? "日志不可读" : `${startedBefore} -> ${startedAfter}`,
    );
    check(
      "AC-07",
      "5 个请求中 1 个成功、4 个 402",
      statuses.filter((s) => s === 200).length === 1 &&
        statuses.filter((s) => s === 402).length === 4,
      `statuses=${JSON.stringify(statuses)}`,
    );
  }

  // ---- AC-08 未登录 -------------------------------------------------------
  {
    const startedBefore = await eventCount("mock-ai.started");
    const anonymous = await call("/operations/generate-plan", { args: { hours: 8 } });
    const startedAfter = await eventCount("mock-ai.started");

    check(
      "AC-08",
      "未登录返回 401",
      anonymous.status === 401,
      `http=${anonymous.status}`,
    );
    check(
      "AC-08",
      "未登录不发起模型调用",
      startedBefore === null ? null : startedAfter === startedBefore,
      startedBefore === null ? "日志不可读" : `${startedBefore} -> ${startedAfter}`,
    );
  }

  // ---- AC-13 参数非法 -----------------------------------------------------
  {
    const session = await newSession("ac13");
    await createTask(session.token, "参数测试");
    const before = await balanceOf(session.token);
    const invalid = await call("/operations/generate-plan", {
      token: session.token,
      args: { hours: "八小时" },
    });

    check(
      "AC-13",
      "hours 类型错误返回 400 且不扣额度",
      invalid.status === 400 && (await balanceOf(session.token)) === before,
      `http=${invalid.status} balance=${before} -> ${await balanceOf(session.token)}`,
    );
  }

  // ---- 汇总 ---------------------------------------------------------------
  const passed = results.filter((r) => r.ok === true).length;
  const failed = results.filter((r) => r.ok === false).length;
  const skipped = results.filter((r) => r.ok === null).length;

  console.log(`\n合计 ${results.length} 项：PASS ${passed}，FAIL ${failed}，SKIP ${skipped}`);

  if (failed > 0) {
    console.log("\n失败项：");
    for (const item of results.filter((r) => r.ok === false)) {
      console.log(`- ${item.id} ${item.assertion} ${item.detail ?? ""}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
