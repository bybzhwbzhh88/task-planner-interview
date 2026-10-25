import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { validateTestDatabaseUrl } from "./test-db.mjs";

const base = new URL(process.env.QUOTA_BROWSER_URL ?? "http://localhost:3000");
assert(["localhost", "127.0.0.1"].includes(base.hostname), "Only a local test application is allowed");
const database = validateTestDatabaseUrl(process.env.QUOTA_BROWSER_DATABASE_URL, null);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href : "playwright");
const browser = await chromium.launch({ channel: process.env.QUOTA_BROWSER_CHANNEL ?? "chrome", headless: true });
const db = new PrismaClient({ datasources: { db: { url: database } } });
const page = await browser.newPage({ viewport: { width: 1365, height: 1100 } });
page.setDefaultTimeout(15000);
const out = resolve(process.env.QUOTA_BROWSER_OUTPUT ?? "test-results/browser");
await mkdir(out, { recursive: true });
const users = [], results = [], errors = [];
const runId = Date.now().toString(36);
const password = "LocalQuotaValidation-2026!";
const button = page.getByTestId("generate-schedule-button");
const balance = page.getByTestId("available-credits");
page.on("pageerror", error => errors.push(error.message));
const waitBalance = async value => {
  await page.waitForFunction(expected => document.querySelector('[data-testid="available-credits"]')?.textContent === `可用额度：${expected}`, value);
};
const note = (id, actual) => { results.push({ id, actual }); console.log(JSON.stringify({ id, actual })); };
const signUp = async suffix => {
  await page.goto(new URL("/signup", base).href);
  await page.locator('input[name="username"]').fill(`quota_${runId}_${suffix}`);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await page.waitForURL("**/demo-app");
  await waitBalance(3);
};
const addTask = async description => {
  await page.getByPlaceholder("输入待办事项").fill(description);
  await page.getByRole("button", { name: "添加任务", exact: true }).click();
  await page.getByText(description, { exact: true }).waitFor();
};
const userForTask = async description => {
  const user = await db.user.findFirstOrThrow({ where: { tasks: { some: { description } } } });
  users.push(user.id);
  return user.id;
};
const stored = async id => ({
  credits: (await db.user.findUniqueOrThrow({ where: { id } })).credits,
  plans: await db.planResult.count({ where: { userId: id } }),
});

try {
  await signUp("a");
  const task = `浏览器核对_${runId}`;
  await addTask(task);
  const userId = await userForTask(task); // Verifies the app and explicit test DB are the same instance.
  const hours = page.getByLabel("今天可用的工作时长");
  await hours.fill("25");
  await page.waitForFunction(() => document.querySelector('[data-testid="generate-schedule-button"]')?.disabled);
  assert(await button.isDisabled());
  await page.getByText("请输入 1–24 小时的有效时长。", { exact: true }).waitFor();
  await hours.fill("8");
  note("A07", "非法时长25禁止生成；恢复8后可生成");

  let requests = 0;
  const count = request => { if (request.url().includes("/operations/generate-plan")) requests++; };
  page.on("request", count);
  const successResponse = page.waitForResponse(response => response.url().includes("/operations/generate-plan"));
  await button.click();
  assert(await button.isDisabled(), "generation must disable the button while in flight");
  assert.equal((await successResponse).status(), 200);
  await page.getByRole("status").filter({ hasText: "日程已生成" }).waitFor();
  await waitBalance(2);
  assert.equal(requests, 1);
  assert.deepEqual(await stored(userId), { credits: 2, plans: 1 });
  await page.screenshot({ path: resolve(out, "success.png"), fullPage: true });
  note("A01/A14", "成功HTTP200；数据库额度3→2，结果1条；生成中禁用，只发起1次请求");

  await page.reload();
  await waitBalance(2);
  await page.getByTestId("schedule").waitFor();
  note("A14-reload", "刷新后额度2和最近日程恢复");

  const failTask = `[fail]_${runId}`;
  await addTask(failTask);
  const failureResponse = page.waitForResponse(response => response.url().includes("/operations/generate-plan"));
  await button.click();
  assert.equal((await failureResponse).status(), 200);
  await page.getByRole("status").filter({ hasText: "本次未消耗额度" }).waitFor();
  await waitBalance(2);
  assert.deepEqual(await stored(userId), { credits: 2, plans: 1 });
  await page.screenshot({ path: resolve(out, "model-failure.png"), fullPage: true });
  note("A03", "模型失败HTTP200业务结果；页面提示未消耗及修正[fail]；数据库额度2，结果仍1条");
  await page.getByRole("button", { name: "删除任务", exact: true }).first().click();

  // Intentionally stale browser balance exercises server-side authorization, not only disabled UI.
  await db.user.update({ where: { id: userId }, data: { credits: 0 } });
  const rejectedResponse = page.waitForResponse(response => response.url().includes("/operations/generate-plan"));
  await button.click();
  assert.equal((await rejectedResponse).status(), 402);
  await page.getByRole("status").filter({ hasText: "本次未调用模型" }).waitFor();
  await waitBalance(0);
  assert(await button.isDisabled());
  assert.deepEqual(await stored(userId), { credits: 0, plans: 1 });
  await page.screenshot({ path: resolve(out, "no-credits.png"), fullPage: true });
  note("A02", "页面旧额度2、真实余额0时服务端返回402；刷新为0并禁用，无新增结果");

  // Isolate the credit-query state from the previous operation's historical 402 feedback.
  await page.reload();
  await waitBalance(0);
  // Simulate another request refunding a credit after this tab cached zero.
  await db.user.update({ where: { id: userId }, data: { credits: 1 } });
  await page.route("**/operations/get-credits", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "synthetic credit query failure" }) }));
  const beforeQueryError = requests;
  await page.getByRole("button", { name: "刷新额度与最近日程", exact: true }).click();
  await page.getByText("额度读取失败，请刷新后确认。", { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await balance.innerText(), "可用额度：暂不可用");
  assert.equal(await page.getByText("当前没有可用额度；若有日程正在生成，请等待结束后刷新。", { exact: true }).count(), 0);
  assert(!await button.isDisabled(), "failed credit reads must not disable generation using cached zero");
  assert.equal(requests, beforeQueryError, "credit query retries must not resend generation");
  assert.deepEqual(await stored(userId), { credits: 1, plans: 1 });
  await page.screenshot({ path: resolve(out, "credit-query-error.png"), fullPage: true });
  await page.unroute("**/operations/get-credits");
  await page.getByRole("button", { name: "刷新额度与最近日程", exact: true }).click();
  await waitBalance(1);
  note("A19", "缓存额度0后模拟其他请求返还为1，额度查询503时显示暂不可用且不按旧0禁用；恢复查询后显示1，无新增生成请求");

  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await signUp("b");
  assert.equal(await page.getByTestId("schedule").count(), 0);
  assert.equal(await page.getByText(task, { exact: true }).count(), 0);
  const secondTask = `隔离账号_${runId}`;
  await addTask(secondTask);
  const secondUser = await userForTask(secondTask);
  note("A14-account", "同一浏览器退出并注册另一账号，额度3，无上一账号任务/结果");

  requests = 0;
  await page.route("**/operations/generate-plan", async route => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch(); // Complete on the real server, then lose only its response.
    assert.equal(response.status(), 200);
    await route.abort("failed");
  });
  await button.click();
  await page.getByRole("status").filter({ hasText: "暂未确认操作结果" }).waitFor();
  await waitBalance(2);
  await page.getByTestId("schedule").waitFor();
  assert.equal(requests, 1, "an interrupted response must not automatically resend generation");
  assert.deepEqual(await stored(secondUser), { credits: 2, plans: 1 });
  await page.unroute("**/operations/generate-plan");
  note("A15-network", "服务端成功后丢弃响应；页面提示先核对，自动刷新恢复额度2和日程；只发起1次生成");

  const auth = await db.auth.findUniqueOrThrow({ where: { userId: secondUser } });
  await db.session.deleteMany({ where: { userId: auth.id } });
  const expiredResponse = page.waitForResponse(response => response.url().includes("/operations/generate-plan"));
  await button.click();
  assert.equal((await expiredResponse).status(), 401);
  // Wasp clears expired auth and redirects protected routes to its real login page.
  await page.waitForURL("**/login");
  await page.getByRole("button", { name: "Log in", exact: true }).waitFor();
  assert.deepEqual(await stored(secondUser), { credits: 2, plans: 1 });
  note("A15-session", "撤销专用测试账号会话后生成返回401；Wasp自动跳转登录页，额度及结果不变");
  assert.deepEqual(errors, []);
  note("browser-errors", "0 uncaught page errors");
  await writeFile(resolve(out, "results.json"), JSON.stringify({ runId, results }, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(out, "failure.png"), fullPage: true }).catch(() => {});
  console.error(await page.locator("body").innerText().catch(() => "Page unavailable"));
  throw error;
} finally {
  await browser.close();
  // Cleanup is limited to users this run identified via its unique task descriptions.
  await db.planResult.deleteMany({ where: { userId: { in: users } } });
  await db.task.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
}
