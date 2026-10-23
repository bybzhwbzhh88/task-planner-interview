// End-to-end verification of quota behavior over the real HTTP API
// (SPEC.md §6: AC-1, AC-2, AC-3 and AC-4 at the HTTP layer, including real
// session auth and the exact operation routes the browser client uses).
//
// Usage: node scripts/verify-http.mjs [apiUrl]
// Default apiUrl: http://localhost:9991 (the Wasp dev API server).
//
// Requires the dev server (`wasp start`) and its database to be running.
// The script creates its own throwaway accounts, so it can run repeatedly
// against the dev database.

const API_URL = process.argv[2] ?? process.env.WASP_API_URL ?? "http://localhost:9991";

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** superjson-style envelope, matching what the browser SDK sends. */
const op = (args) => (args === undefined ? { meta: {} } : { json: args, meta: {} });

async function call(path, { body, sessionId } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sessionId ? { authorization: `Bearer ${sessionId}` } : {}),
    },
    body: JSON.stringify(body ?? { meta: {} }),
  });
  let parsed = null;
  try {
    parsed = JSON.parse(await res.text());
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: parsed };
}

/** Unwrap superjson envelopes ({ json, meta }) and plain bodies alike. */
function unwrap(body) {
  if (body && typeof body === "object" && "json" in body) return body.json;
  return body;
}

async function createAccount(label) {
  const username = `${label}_${crypto.randomUUID().slice(0, 8)}`;
  const password = "Passw0rd!verify";
  await call("/auth/username/signup", { body: { username, password } });
  const login = await call("/auth/username/login", {
    body: { username, password },
  });
  const sessionId = unwrap(login.body)?.sessionId;
  if (!sessionId) {
    throw new Error(`login did not return a sessionId: ${JSON.stringify(login)}`);
  }
  return { username, sessionId };
}

async function creditsOf(sessionId) {
  const res = await call("/operations/get-user-credits", { sessionId });
  return unwrap(res.body)?.credits;
}

async function addTask(sessionId, description) {
  const res = await call("/operations/create-task", {
    sessionId,
    body: op({ description }),
  });
  return unwrap(res.body)?.id;
}

async function generate(sessionId, hours = 8) {
  return call("/operations/generate-plan", {
    sessionId,
    body: op({ hours }),
  });
}

console.log(`# HTTP 验证 against ${API_URL}\n`);

// --- User A: AC-1 (success) + AC-4 (concurrency) + AC-2 (single 402) -------
{
  const { sessionId } = await createAccount("quota");
  console.log("user A: 注册并登录成功");

  await addTask(sessionId, "写周报");
  check("user A 初始额度为 3", (await creditsOf(sessionId)) === 3);

  // AC-1: successful generation consumes exactly one credit.
  const first = await generate(sessionId);
  check("AC-1: 首次生成返回 200", first.status === 200, `status=${first.status}`);
  check("AC-1: 返回日程内容", Array.isArray(unwrap(first.body)?.tasks));
  check("AC-1: 额度 3 → 2", (await creditsOf(sessionId)) === 2);

  // AC-4: 2 credits left, 10 concurrent requests → exactly 2 succeed.
  const burst = await Promise.all(
    Array.from({ length: 10 }, () => generate(sessionId)),
  );
  const ok = burst.filter((r) => r.status === 200).length;
  const rejected = burst.filter((r) => r.status === 402).length;
  check("AC-4: 10 个并发请求恰好 2 个 200", ok === 2, `ok=${ok}`);
  check("AC-4: 其余 8 个为 402", rejected === 8, `rejected=${rejected}`);
  check("AC-4: 并发后额度为 0（未透支）", (await creditsOf(sessionId)) === 0);

  // AC-2: out of credits → single request rejected without provider call.
  const after = await generate(sessionId);
  check("AC-2: 额度不足返回 402", after.status === 402, `status=${after.status}`);
  const message = after.body?.message ?? "";
  check(
    "AC-2: 402 文案说明额度已用完及下一步",
    message.includes("额度") && message.includes("重置"),
    message,
  );
  check("AC-2: 额度仍为 0", (await creditsOf(sessionId)) === 0);
}

// --- User B: AC-3 (provider failure refunds) -------------------------------
{
  const { sessionId } = await createAccount("fail");
  console.log("user B: 注册并登录成功");

  // A normal task so that removing the [fail] task leaves work to schedule.
  await addTask(sessionId, "写周报");
  const taskId = await addTask(sessionId, "包含 [fail] 的任务");
  const failed = await generate(sessionId);
  check(
    "AC-3: 模型失败返回 500",
    failed.status === 500,
    `status=${failed.status}`,
  );
  const message = failed.body?.message ?? "";
  check(
    "AC-3: 500 文案说明本次未消耗额度",
    message.includes("未消耗额度"),
    message,
  );
  check("AC-3: 额度退还后仍为 3", (await creditsOf(sessionId)) === 3);

  // Removing the [fail] task restores the success path.
  await call("/operations/delete-task", {
    sessionId,
    body: op({ id: taskId }),
  });
  const ok = await generate(sessionId);
  check("AC-3: 删除 [fail] 任务后重试成功", ok.status === 200, `status=${ok.status}`);
  check("AC-3: 成功后额度 3 → 2", (await creditsOf(sessionId)) === 2);
}

console.log("");
if (failures.length > 0) {
  console.log(`FAILED: ${failures.length} 项未通过`);
  process.exit(1);
}
console.log("ALL PASSED");
