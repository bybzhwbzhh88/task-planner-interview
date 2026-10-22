const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

if (process.argv.includes("--help")) {
  console.log("SERVER_LOG=<actual server log> [PLAYWRIGHT_MODULE_PATH=<installed playwright>] node scripts/verify-browser.cjs\nUses repository Playwright and Chromium on Linux, or Edge on Windows. App at FRONTEND_URL / API_URL, defaults localhost:3000 / 3001. Credentials remain in memory; screenshots and JSON go to test-results/quota/browser.");
  process.exit(0);
}
const logPath = process.env.SERVER_LOG || path.resolve(__dirname, "../test-results/quota/server.log");
const frontend = process.env.FRONTEND_URL || "http://localhost:3000";
const api = process.env.API_URL || "http://localhost:3001";
const out = path.resolve(__dirname, "../test-results/quota/browser");
fs.mkdirSync(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), steps: [], pageErrors: [], passed: false };

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined), headless: true });
  report.browser = "Chromium/Edge " + browser.version();
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  context.on("page", (page) => {
    page.setDefaultTimeout(30000);
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
  });
  const page = await context.newPage();
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function rpc(activePage, endpoint, args, method = "POST") {
    return activePage.evaluate(async ({ api, endpoint, args, method }) => {
      const token = JSON.parse(localStorage.getItem("wasp:sessionId"));
      const response = await fetch(api + endpoint, {
        method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        ...(method === "GET" ? {} : { body: JSON.stringify(args === undefined ? { json: null, meta: { values: ["undefined"], v: 1 } } : { json: args }) }),
      });
      const body = await response.json();
      return { status: response.status, body: response.ok ? body.json : body };
    }, { api, endpoint, args, method });
  }
  async function state(activePage = page) {
    const me = await rpc(activePage, "/auth/me", undefined, "GET");
    const results = await rpc(activePage, "/operations/get-plan-results");
    assert.equal(me.status, 200);
    assert.equal(results.status, 200);
    return { C: me.body.credits, R: results.body.length };
  }
  async function credits(activePage, expected) {
    await activePage.waitForFunction((value) =>
      document.querySelector('[data-testid="available-credits"]')?.textContent?.trim().endsWith(String(value)), expected);
  }
  async function finished(activePage) {
    await activePage.waitForFunction(() =>
      !document.querySelector('[data-testid="generate-schedule-button"]')?.textContent?.includes("生成中"));
  }
  async function generate(activePage = page) {
    const pending = activePage.waitForResponse((response) =>
      response.url() === api + "/operations/generate-plan" && response.request().method() === "POST");
    await activePage.getByTestId("generate-schedule-button").click();
    const response = await pending;
    await finished(activePage);
    return response.status();
  }
  async function add(description) {
    await page.getByPlaceholder("输入待办事项").fill(description);
    await page.getByRole("button", { name: "添加任务", exact: true }).click();
    await page.getByText(description, { exact: true }).first().waitFor();
  }
  async function capture(id, action, expected) {
    const before = await state();
    const offset = fs.statSync(logPath).size;
    const status = await action();
    const after = await state();
    await delay(100);
    const log = fs.readFileSync(logPath).subarray(offset).toString("utf8");
    const starts = [...log.matchAll(/\{"event":"mock-ai\.started","callId":"([^"]+)"\}/g)];
    assert.equal(status, expected.status, id);
    assert.equal(after.C, expected.C, id);
    assert.equal(after.R - before.R, expected.R, id);
    assert.equal(starts.length, expected.M, id);
    report.steps.push({ id, passed: true, status, before, after, deltaR: after.R - before.R, modelCalls: starts.length });
    console.log("PASS", id, JSON.stringify(report.steps.at(-1)));
  }

  try {
    const anonymous = await browser.newContext();
    try {
      const anonymousPage = await anonymous.newPage();
      const offset = fs.statSync(logPath).size;
      for (const route of ["/", "/demo-app"]) {
        await anonymousPage.goto(frontend + route, { waitUntil: "networkidle" });
        await anonymousPage.waitForURL("**/login");
      }
      const denied = await anonymous.request.post(api + "/operations/generate-plan", { data: { json: { hours: 8 } } });
      assert.equal(denied.status(), 401);
      await delay(100);
      const log = fs.readFileSync(logPath).subarray(offset).toString("utf8");
      const modelCalls = [...log.matchAll(/\{"event":"mock-ai\.started","callId":"([^"]+)"\}/g)].length;
      assert.equal(modelCalls, 0);
      report.steps.push({ id: "AC12-AC24-unauthenticated-guard", passed: true, redirectedToLogin: true, protectedRoutes: ["/", "/demo-app"], status: 401, modelCalls: 0, deltaR: 0 });
      console.log("PASS AC12-AC24-unauthenticated-guard");
    } finally { await anonymous.close(); }

    const account = { username: "browser_" + Date.now(), password: "Test_" + randomBytes(18).toString("hex") };
    await page.goto(frontend + "/signup", { waitUntil: "networkidle" });
    await page.locator('input[name="username"]').fill(account.username);
    await page.locator('input[name="password"]').fill(account.password);
    await page.getByRole("button", { name: "Sign up", exact: true }).click();
    await page.waitForURL("**/demo-app");
    await credits(page, 3);
    assert.equal(await page.getByTestId("generate-schedule-button").isDisabled(), true);
    report.steps.push({ id: "AC01-UI", passed: true, C: 3, emptyTaskButtonDisabled: true });

    await add("浏览器验收普通任务");
    await capture("AC02-UI", () => generate(), { status: 200, C: 2, R: 1, M: 1 });
    await credits(page, 2);
    assert.match(await page.getByTestId("plan-feedback").innerText(), /已消费 1/);
    await page.screenshot({ path: path.join(out, "success.png"), fullPage: true });
    await capture("prepare-last-credit", () => generate(), { status: 200, C: 1, R: 1, M: 1 });
    await credits(page, 1);

    await add("[fail] 浏览器失败任务");
    await capture("AC05-UI", () => generate(), { status: 502, C: 1, R: 0, M: 1 });
    await credits(page, 1);
    assert.match(await page.getByTestId("plan-feedback").innerText(), /额度已释放/);
    assert.equal(await page.getByTestId("schedule-heading").innerText(), "上次成功生成的日程");
    assert.equal(await page.getByTestId("generate-schedule-button").isEnabled(), true);
    await page.screenshot({ path: path.join(out, "failure-released.png"), fullPage: true });
    await page.getByText("[fail] 浏览器失败任务", { exact: true })
      .locator('xpath=ancestor::div[contains(@class,"p-4")][1]').getByTitle("删除任务").click();
    await page.getByText("[fail] 浏览器失败任务", { exact: true }).waitFor({ state: "detached" });

    const tabB = await context.newPage();
    await tabB.goto(frontend + "/demo-app", { waitUntil: "networkidle" });
    await credits(tabB, 1);
    await page.bringToFront();
    await capture("AC03-AC06-UI", () => generate(), { status: 200, C: 0, R: 1, M: 1 });
    await credits(page, 0);
    assert.equal(await page.getByTestId("generate-schedule-button").isDisabled(), true);
    await tabB.bringToFront();
    // Dispatching focus also makes this check reproducible in headless window managers.
    await tabB.evaluate(() => window.dispatchEvent(new Event("focus")));
    await credits(tabB, 0);
    assert.equal(await tabB.getByTestId("generate-schedule-button").isDisabled(), true);
    await capture("AC04-AC13-stale-direct-request", async () =>
      (await rpc(tabB, "/operations/generate-plan", { hours: 8 })).status,
      { status: 402, C: 0, R: 0, M: 0 });
    await tabB.screenshot({ path: path.join(out, "zero-credit-two-tabs.png"), fullPage: true });
    await tabB.close();

    // Separate new account for error presentation. These response injections test
    // only the UI; real database fault semantics are covered by integration tests.
    await page.getByRole("button", { name: "退出登录" }).click();
    await page.waitForURL("**/login");
    await page.goto(frontend + "/signup");
    await page.locator('input[name="username"]').fill("ui_errors_" + Date.now());
    await page.locator('input[name="password"]').fill("Test_" + randomBytes(18).toString("hex"));
    await page.getByRole("button", { name: "Sign up", exact: true }).click();
    await page.waitForURL("**/demo-app");
    await credits(page, 3);
    await add("界面错误提示验证");
    await page.locator("#todays-hours").fill("25");
    assert.equal(await page.getByTestId("generate-schedule-button").isDisabled(), true);
    await page.getByRole("alert").getByText("可用时长须为 1～24 小时。").waitFor();
    await page.locator("#todays-hours").fill("8");
    report.steps.push({ id: "AC12-UI", passed: true, invalidHoursDisabled: true });
    // Fail only the page's auth refresh. Independent API reads still observe
    // the real committed balance/result; generate-plan remains untouched.
    const token = await page.evaluate(() => JSON.parse(localStorage.getItem("wasp:sessionId")));
    const readServerState = async () => {
      const headers = { Authorization: "Bearer " + token };
      const me = await context.request.get(api + "/auth/me", { headers });
      const results = await context.request.post(api + "/operations/get-plan-results", {
        headers, data: { json: null, meta: { values: ["undefined"], v: 1 } },
      });
      assert.equal(me.status(), 200);
      assert.equal(results.status(), 200);
      return { C: (await me.json()).json.credits, R: (await results.json()).json.length };
    };
    const beforeRefreshFailure = await readServerState();
    const refreshLogOffset = fs.statSync(logPath).size;
    let generationRequests = 0;
    let failedAuthResponses = 0;
    const countGeneration = (request) => {
      if (request.url() === api + "/operations/generate-plan" && request.method() === "POST") generationRequests++;
    };
    const blockAuth = async (route) => {
      failedAuthResponses++;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Auth refresh probe" }) });
    };
    const countModelStarts = () => {
      const log = fs.readFileSync(logPath).subarray(refreshLogOffset).toString("utf8");
      return [...log.matchAll(/\{"event":"mock-ai\.started","callId":"([^"]+)"\}/g)].length;
    };
    page.on("request", countGeneration);
    await page.route(api + "/auth/me", blockAuth);
    try {
      const pending = page.waitForResponse((response) =>
        response.url() === api + "/operations/generate-plan" && response.request().method() === "POST");
      await page.getByTestId("generate-schedule-button").click();
      const generated = await pending;
      assert.equal(generated.status(), 200);
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="plan-feedback"]')?.textContent?.includes("生成成功") &&
        !document.querySelector('[data-testid="generate-schedule-button"]')?.textContent?.includes("生成中"),
        undefined, { timeout: 90000 });
      await page.getByRole("button", { name: "额度读取失败，点击刷新", exact: true }).waitFor();
      assert.equal(await page.getByTestId("schedule").isVisible(), true);
      assert.equal(await page.getByTestId("schedule-heading").innerText(), "本次日程");
      assert.match(await page.getByTestId("plan-feedback").innerText(), /生成成功，已消费 1 个额度/);
      assert.equal(await page.getByTestId("generate-schedule-button").isDisabled(), true);
      const committed = await readServerState();
      assert.deepEqual(beforeRefreshFailure, { C: 3, R: 0 });
      assert.deepEqual(committed, { C: 2, R: 1 });
      assert.equal(countModelStarts(), 1);
      assert.equal(generationRequests, 1);
      assert.ok(failedAuthResponses > 0);
      report.steps.push({
        id: "AC24-success-auth-refresh-failed", passed: true, status: 200,
        before: beforeRefreshFailure, after: committed, deltaR: 1, modelCalls: 1,
        generationRequests, failedAuthResponses, successScheduleRetained: true, quotaReadErrorVisible: true,
      });
      console.log("PASS AC24-success-auth-refresh-failed");
      await page.screenshot({ path: path.join(out, "success-auth-refresh-failed.png"), fullPage: true });
    } finally {
      await page.unroute(api + "/auth/me", blockAuth);
    }
    try {
      await page.getByRole("button", { name: "额度读取失败，点击刷新", exact: true }).click();
      await credits(page, 2);
      assert.equal(await page.getByTestId("generate-schedule-button").isEnabled(), true);
      assert.equal(await page.getByTestId("schedule-heading").innerText(), "本次日程");
      assert.match(await page.getByTestId("plan-feedback").innerText(), /生成成功/);
      assert.deepEqual(await readServerState(), { C: 2, R: 1 });
      assert.equal(generationRequests, 1);
      assert.equal(countModelStarts(), 1);
      report.steps.push({
        id: "AC24-auth-refresh-recovered", passed: true,
        before: { C: 2, R: 1 }, after: { C: 2, R: 1 }, deltaR: 0, modelCalls: 0,
        generationRequestsAfterRecovery: generationRequests, displayedCredits: 2,
      });
      console.log("PASS AC24-auth-refresh-recovered");
    } finally {
      page.off("request", countGeneration);
    }

    for (const probe of [
      { id: "AC10-UI-injected", status: 500, code: "SAVE_FAILED", text: /保存失败，额度已释放/ },
      { id: "AC18-UI-injected", status: 503, code: "OUTCOME_UNKNOWN", text: /结果暂无法确认/ },
      { id: "AC15-UI-injected", status: 503, code: "DB_UNAVAILABLE", text: /本次未消费额度/ },
      { id: "non-json-error-UI-injected", status: 500, html: true, text: /结果暂无法确认/ },
    ]) {
      let requests = 0;
      await page.route(api + "/operations/generate-plan", async (route) => {
        requests++;
        await route.fulfill({
          status: probe.status,
          contentType: probe.html ? "text/html" : "application/json",
          body: probe.html ? "<html>Internal server error</html>" : JSON.stringify({
            message: "UI test response", data: { code: probe.code, attemptId: "ui-response-probe" },
          }),
        });
      });
      await capture(probe.id, () => generate(), { status: probe.status, C: 2, R: 0, M: 0 });
      assert.match(await page.getByTestId("plan-feedback").innerText(), probe.text);
      if (probe.code === "OUTCOME_UNKNOWN") {
        assert.doesNotMatch(await page.getByTestId("plan-feedback").innerText(), /未扣费|已释放|未消费/);
        assert.match(await page.getByTestId("plan-feedback").innerText(), /ui-response-probe/);
      }
      assert.equal(requests, 1, "no automatic generation retry");
      assert.equal(await page.getByTestId("schedule-heading").innerText(), "上次成功生成的日程");
      await page.unroute(api + "/operations/generate-plan");
    }
    await page.screenshot({ path: path.join(out, "unknown-outcome.png"), fullPage: true });
    const beforeAuthRejection = await state();
    const rejectionOffset = fs.statSync(logPath).size;
    await page.route(api + "/auth/me", (route) => route.fulfill({
      status: 403, contentType: "application/json", body: JSON.stringify({ message: "Auth rejection probe" }),
    }));
    try {
      await page.getByRole("button", { name: "刷新额度", exact: true }).click();
      await page.getByText("登录状态已失效，请退出后重新登录。", { exact: true }).waitFor();
      assert.equal(await page.getByTestId("generate-schedule-button").count(), 0);
      assert.ok(page.url().endsWith("/demo-app"), "auth rejection must not loop between login and demo");
    } finally { await page.unroute(api + "/auth/me"); }
    await page.getByRole("button", { name: "额度读取失败，点击刷新", exact: true }).click();
    await credits(page, 2);
    assert.deepEqual(await state(), beforeAuthRejection);
    const rejectionLog = fs.readFileSync(logPath).subarray(rejectionOffset).toString("utf8");
    assert.equal([...rejectionLog.matchAll(/\{"event":"mock-ai\.started","callId":"([^"]+)"\}/g)].length, 0);
    report.steps.push({ id: "AC24-auth-rejected-UI-injected", passed: true, cachedViewBlocked: true,
      noRedirectLoop: true, before: beforeAuthRejection, after: beforeAuthRejection, modelCalls: 0, deltaR: 0 });
    console.log("PASS AC24-auth-rejected-UI-injected");
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    report.bodyAtFailure = await page.locator("body").innerText().catch(() => "");
    await page.screenshot({ path: path.join(out, "failure-debug.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
