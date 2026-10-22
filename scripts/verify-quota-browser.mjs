import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";

const { values } = parseArgs({ options: {
  "base-url": { type: "string", default: "http://localhost:3000" },
  "api-url": { type: "string", default: "http://localhost:3001" },
  "log-file": { type: "string" },
} });
if (process.env.QUOTA_ALLOW_HTTP_TESTS !== "1" || !process.env.DATABASE_URL || !values["log-file"]) {
  throw new Error("Set DATABASE_URL, QUOTA_ALLOW_HTTP_TESTS=1 and --log-file; see docs/VERIFICATION.md.");
}
for (const address of [values["base-url"], values["api-url"], process.env.DATABASE_URL]) {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(address).hostname)) {
    throw new Error("Browser verification only supports a local app and local PostgreSQL.");
  }
}
// Optional isolated tooling installation; no production dependency or test backdoor.
const { chromium } = await import(process.env.QUOTA_PLAYWRIGHT_MODULE || "playwright");
const db = new PrismaClient();
const ids = [];
const results = [];
const browser = await chromium.launch({ headless: true });
mkdirSync("test-results", { recursive: true });
let activePage;
let scenario = "initialization";
let inspectCurrent;
let failureEvidence;
function calls() {
  return (readFileSync(values["log-file"], "utf8").match(/"event":"mock-ai.started"/g) || []).length;
}
async function api(path, body) {
  const response = await fetch(new URL(path, values["api-url"]), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, path);
}
async function state(id) {
  return { credits: (await db.user.findUniqueOrThrow({ where: { id } })).credits,
    saved: await db.planResult.count({ where: { userId: id } }) };
}
async function visible(locator) { await locator.waitFor({ state: "visible", timeout: 20000 }); }
async function enabled(locator, expected) {
  for (let i = 0; i < 100; i++) {
    if (await locator.isEnabled() === expected) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await locator.isEnabled(), expected, "button enabled state");
}
function passed(name, details = {}) {
  results.push({ name, ...details });
  console.log(`PASS ${name}`);
}
try {
  calls();
  for (const entry of ["/", "/demo-app"]) {
    const username = `browser${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    const password = `${randomUUID()}!aA1`;
    await api("/auth/username/signup", { username, password });
    const identity = await db.authIdentity.findUniqueOrThrow({
      where: { providerName_providerUserId: { providerName: "username", providerUserId: username } },
      include: { auth: true },
    });
    const id = identity.auth.userId;
    assert.ok(id, "HTTP account must exist in DATABASE_URL");
    ids.push(id);
    const context = await browser.newContext();
    const page = activePage = await context.newPage();
    page.setDefaultTimeout(20000);
    let fault = 0;
    let injected = 0;
    let generated = 0;
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/operations/generate-plan" && request.method() === "POST") generated++;
    });
    await page.route("**/auth/me", async route => {
      if (!fault) return route.continue();
      injected++;
      await route.fulfill({ status: fault, contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": values["base-url"], "Access-Control-Allow-Credentials": "true" },
        body: JSON.stringify({ message: "Injected browser authentication response" }) });
    });
    await page.goto(new URL("/login", values["base-url"]).href);
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await visible(page.getByPlaceholder("输入待办事项"));
    await page.goto(new URL(entry, values["base-url"]).href);
    await page.getByPlaceholder("输入待办事项").fill("浏览器回归测试任务");
    await page.getByRole("button", { name: "添加任务", exact: true }).click();
    const generate = page.getByTestId("generate-schedule-button");
    await enabled(generate, true);
    const started = calls();
    inspectCurrent = async () => ({ ...await state(id), generated, modelStarted: calls() - started,
      injected, scheduleVisible: await page.getByTestId("schedule").isVisible(),
      successVisible: await page.getByTestId("generation-message").filter({ hasText: "日程已生成并保存" }).isVisible() });
    scenario = `${entry}: success`;
    await generate.click();
    await visible(page.getByTestId("generation-message").filter({ hasText: "日程已生成并保存" }));
    await visible(page.getByTestId("schedule"));
    await enabled(generate, true);
    assert.deepEqual(await state(id), { credits: 2, saved: 1 });
    assert.equal(calls() - started, 1);
    passed(scenario);

    scenario = `${entry}: cached identity + persistent 503 retains result`;
    fault = 503;
    await page.getByRole("button", { name: "刷新额度", exact: true }).click();
    await visible(page.getByRole("alert").filter({ hasText: "暂时无法读取额度" }));
    assert.ok(injected > 0, "fault must actually intercept authentication requests");
    assert.equal(await page.getByTestId("schedule").isVisible(), true);
    assert.match(await page.getByTestId("generation-message").innerText(), /日程已生成并保存/);
    await enabled(generate, false);
    await page.screenshot({ path: `test-results/auth-refresh-${entry === "/" ? "home" : "demo"}.png`, fullPage: true });
    fault = 0;
    await page.getByRole("button", { name: "刷新额度", exact: true }).click();
    await enabled(generate, true);
    assert.equal(await page.getByTestId("schedule").isVisible(), true);
    assert.deepEqual(await state(id), { credits: 2, saved: 1 });
    assert.equal(generated, 1, "refresh/recovery must not generate again");
    assert.equal(calls() - started, 1);
    passed(scenario, { generated, modelStarted: calls() - started, ...await state(id) });

    scenario = `${entry}: explicit model failure preserves old result`;
    await page.getByPlaceholder("输入待办事项").fill("[fail] 浏览器明确失败");
    await page.getByRole("button", { name: "添加任务", exact: true }).click();
    await visible(page.getByText("[fail] 浏览器明确失败", { exact: true }));
    await generate.click();
    await visible(page.getByTestId("generation-message").filter({ hasText: "本次生成失败，未消耗额度" }));
    await visible(page.getByRole("heading", { name: "上次生成结果", exact: true }));
    await enabled(generate, true);
    assert.deepEqual(await state(id), { credits: 2, saved: 1 });
    assert.equal(calls() - started, 2);
    passed(scenario);

    scenario = `${entry}: zero credits and saved-result lookup`;
    await db.user.update({ where: { id }, data: { credits: 0 } });
    await page.getByRole("button", { name: "刷新额度", exact: true }).click();
    await enabled(generate, false);
    await page.getByRole("button", { name: "查看最近保存的日程", exact: true }).click();
    await visible(page.getByTestId("generation-message").filter({ hasText: "此操作不消耗额度" }));
    assert.deepEqual(await state(id), { credits: 0, saved: 1 });
    assert.equal(generated, 2);
    assert.equal(calls() - started, 2);
    passed(scenario);

    for (const status of [401, 403]) {
      scenario = `${entry}: cached identity + ${status} blocks private page`;
      fault = status;
      await page.getByRole("button", { name: "刷新额度", exact: true }).click();
      const expired = page.getByRole("alert").filter({ hasText: "登录已失效" });
      // Wasp clears the session on 401; a redirect to login is also correct.
      await visible(status === 401 ? expired.or(page.locator('input[name="username"]')) : expired);
      assert.equal(await page.getByTestId("schedule").count(), 0);
      assert.equal(await page.getByPlaceholder("输入待办事项").count(), 0);
      if (status === 401) {
        if (await expired.isVisible()) await page.getByRole("link", { name: "前往登录", exact: true }).click();
        await visible(page.locator('input[name="username"]'));
        assert.equal(new URL(page.url()).pathname, "/login", "stale identity must not redirect back to planner");
        fault = 0;
        await page.locator('input[name="username"]').fill(username);
        await page.locator('input[name="password"]').fill(password);
        await page.getByRole("button", { name: "Log in", exact: true }).click();
        await visible(page.getByPlaceholder("输入待办事项"));
        await page.goto(new URL(entry, values["base-url"]).href);
      } else {
        fault = 0;
        await page.getByRole("button", { name: "重试身份验证", exact: true }).click();
      }
      await visible(page.getByPlaceholder("输入待办事项"));
      passed(scenario);
    }

    scenario = `${entry}: first authentication 503 fails closed and recovers`;
    fault = 503;
    await page.reload();
    await visible(page.getByRole("alert").filter({ hasText: "暂时无法验证登录状态" }));
    assert.equal(await page.getByPlaceholder("输入待办事项").count(), 0);
    fault = 0;
    await page.getByRole("button", { name: "重试身份验证", exact: true }).click();
    await visible(page.getByPlaceholder("输入待办事项"));
    assert.equal(generated, 2);
    assert.equal(calls() - started, 2);
    passed(scenario);
    await context.close();

    scenario = `${entry}: anonymous page and server operation are protected`;
    const anonymous = await browser.newContext();
    const anonymousPage = activePage = await anonymous.newPage();
    await anonymousPage.goto(new URL(entry, values["base-url"]).href);
    await anonymousPage.waitForURL("**/login");
    assert.equal(await anonymousPage.getByPlaceholder("输入待办事项").count(), 0);
    const response = await fetch(new URL("/operations/generate-plan", values["api-url"]), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ json: { hours: 8 } }),
    });
    assert.equal(response.status, 401);
    await anonymous.close();
    passed(scenario);
  }
  console.log(`PASS: ${results.length} browser scenarios`);
} catch (error) {
  failureEvidence = await inspectCurrent?.().catch(() => undefined);
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: "test-results/browser-failure.png", fullPage: true }).catch(() => {});
  }
  console.error(`FAIL ${scenario}: ${error.message}`);
  if (failureEvidence) console.error(JSON.stringify(failureEvidence));
  process.exitCode = 1;
} finally {
  writeFileSync("test-results/quota-browser.json", JSON.stringify({
    recordedAt: new Date().toISOString(), passed: !process.exitCode,
    ...(process.exitCode ? { failedScenario: scenario, failureEvidence } : {}), results,
  }, null, 2));
  await browser.close();
  try {
    await db.$transaction([
      db.planResult.deleteMany({ where: { userId: { in: ids } } }),
      db.task.deleteMany({ where: { userId: { in: ids } } }),
      db.user.deleteMany({ where: { id: { in: ids } } }),
    ]);
  } finally { await db.$disconnect(); }
}
