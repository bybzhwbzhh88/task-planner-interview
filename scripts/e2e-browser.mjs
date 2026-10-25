/**
 * 浏览器 + HTTP 端到端验证脚本。
 *
 * 前置条件：
 * 1. 已按 README 启动本地 PostgreSQL，并执行迁移。
 * 2. 已运行 `wasp start`（默认客户端 http://localhost:3000，服务端 http://localhost:3001）。
 * 3. 已安装 puppeteer-core 与系统 Chrome：
 *      npm install --prefix .e2e-tools puppeteer-core@24
 *
 * 运行：
 *   E2E_DATABASE_URL='postgresql://...' node scripts/e2e-browser.mjs
 *
 * 覆盖：A01 UI 成功与额度刷新、A12 刷新后恢复最近日程、A13 额度不足提示、
 * A03 模型失败不扣额度，以及 A05 经 HTTP 的 10 并发请求。
 * 脚本只创建以 e2e-quota- 前缀的账号，并在结束时清理。
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const require = createRequire(new URL("../.e2e-tools/", import.meta.url));
const puppeteer = require("puppeteer-core");

const CLIENT_URL = process.env.E2E_CLIENT_URL ?? "http://localhost:3000";
const SERVER_URL = process.env.E2E_SERVER_URL ?? "http://localhost:3001";
const DATABASE_URL = process.env.E2E_DATABASE_URL;
const CHROME_PATH =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const screenshotsDir = fileURLToPath(new URL("../docs/verification/", import.meta.url));
const profileDir = fileURLToPath(new URL("../.e2e-artifacts/chrome-profile/", import.meta.url));
mkdirSync(screenshotsDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });

const runId = randomUUID().slice(0, 8);
const accountPrefix = `e2e-quota-${runId}`;
const createdUserIds = [];

function log(step, detail = "") {
  console.log(`[e2e] ${step}${detail ? `: ${detail}` : ""}`);
}

async function http(path, { method = "POST", body, sessionId } = {}) {
  const response = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(sessionId ? { authorization: `Bearer ${sessionId}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

/** Wasp 0.25 操作接口使用 superjson：请求体为 { json: args }，响应体为 { json: result }。 */
async function operation(name, args, sessionId) {
  const result = await http(`/operations/${name}`, { body: { json: args }, sessionId });
  return { status: result.status, body: result.json?.json ?? result.json };
}

async function createAccount(label) {
  const username = `${accountPrefix}-${label}`;
  const password = `pw-${runId}-${label}`;
  const signup = await http("/auth/username/signup", { body: { username, password } });
  assert.equal(signup.status, 200, `注册 ${label} 失败: ${signup.status}`);
  const login = await http("/auth/username/login", { body: { username, password } });
  assert.equal(login.status, 200, `登录 ${label} 失败: ${login.status}`);
  const sessionId = login.json?.sessionId;
  assert.ok(sessionId, "登录响应缺少 sessionId");
  const me = await http("/auth/me", { method: "GET", sessionId });
  const user = me.json?.json;
  assert.ok(user?.id, "auth/me 未返回用户");
  createdUserIds.push(user.id);
  return { username, sessionId, userId: user.id };
}

async function credits(account) {
  const result = await operation("get-available-credits", { viewerId: account.userId }, account.sessionId);
  assert.equal(result.status, 200, `额度查询失败: ${result.status}`);
  return result.body.availableCredits;
}

async function addTask(account, description) {
  const result = await operation("create-task", { description }, account.sessionId);
  assert.equal(result.status, 200, `创建任务失败: ${result.status}`);
}

async function generate(account) {
  return operation("generate-plan", { hours: 8 }, account.sessionId);
}

async function newPage(browser, sessionId) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  await page.evaluateOnNewDocument((value) => {
    try {
      localStorage.setItem("wasp:sessionId", JSON.stringify(value));
    } catch {
      // about:blank 等上下文可能不可写，忽略。
    }
  }, sessionId);
  page.on("pageerror", (error) => log("pageerror", String(error)));
  return page;
}

async function waitForText(page, text, timeout = 15_000) {
  await page.waitForFunction(
    (needle) => document.body.innerText.includes(needle),
    { timeout },
    text,
  );
}

async function clickGenerate(page) {
  await waitForText(page, "可用额度");
  await page.waitForSelector('[data-testid="generate-schedule-button"]:not([disabled])', { timeout: 15_000 });
  await page.evaluate(() => document.querySelector('[data-testid="generate-schedule-button"]')?.click());
}

async function main() {
  assert.ok(DATABASE_URL, "缺少 E2E_DATABASE_URL（用于清理测试账号）");
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    userDataDir: profileDir,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  try {
    // ---------- A01 / A15 / A12：成功生成、防重复点击、刷新恢复 ----------
    const alice = await createAccount("alice");
    await addTask(alice, "写周报");
    log("A01 前置：alice 注册并添加任务");

    const alicePage = await newPage(browser, alice.sessionId);
    await alicePage.goto(`${CLIENT_URL}/demo-app`, { waitUntil: "networkidle2", timeout: 30_000 });
    await alicePage.waitForSelector('[data-testid="available-credits"]', { timeout: 20_000 });
    await waitForText(alicePage, "可用额度：3");
    log("A01 页面显示初始额度 3");

    await clickGenerate(alicePage);
    const disabledWhileGenerating = await alicePage.evaluate(
      () => document.querySelector('[data-testid="generate-schedule-button"]')?.disabled,
    );
    assert.equal(disabledWhileGenerating, true, "A15 生成中按钮应禁用");
    log("A15 生成中按钮已禁用");

    await waitForText(alicePage, "生成成功", 20_000);
    await alicePage.waitForFunction(
      () => /可用额度：\s*2\b/.test(document.querySelector('[data-testid="available-credits"]')?.textContent ?? ""),
      { timeout: 15_000 },
    );
    assert.equal(await credits(alice), 2);
    log("A01 成功提示出现，额度从 3 变为 2");

    await alicePage.reload({ waitUntil: "networkidle2" });
    await waitForText(alicePage, "最近一次成功生成的日程", 20_000);
    await waitForText(alicePage, "写周报");
    await alicePage.screenshot({ path: `${screenshotsDir}/e2e-success.png`, fullPage: true });
    log("A12 刷新后恢复最近成功日程");

    // ---------- A13：额度不足（多个页面/标签页导致展示额度过期） ----------
    assert.equal((await generate(alice)).status, 200);
    assert.equal((await generate(alice)).status, 200);
    assert.equal(await credits(alice), 0);
    // 不刷新页面：页面仍显示旧额度 2、按钮仍可点击；服务端必须以 402 拒绝且不调用模型。
    await waitForText(alicePage, "可用额度：2");
    await clickGenerate(alicePage);
    await waitForText(alicePage, "额度不足", 20_000);
    await waitForText(alicePage, "本次未调用模型", 20_000);
    await alicePage.waitForFunction(
      () => /可用额度：\s*0\b/.test(document.querySelector('[data-testid="available-credits"]')?.textContent ?? ""),
      { timeout: 15_000 },
    );
    const disabledAtZero = await alicePage.evaluate(
      () => document.querySelector('[data-testid="generate-schedule-button"]')?.disabled,
    );
    assert.equal(disabledAtZero, true, "A13 刷新额度后生成按钮应禁用");
    await waitForText(alicePage, "当前没有可用额度");
    await alicePage.screenshot({ path: `${screenshotsDir}/e2e-no-credits.png`, fullPage: true });
    log("A13 过期额度下点击被 402 拒绝，页面提示未调用模型并刷新为 0");

    // ---------- A03：模型明确失败不扣额度 ----------
    const bob = await createAccount("bob");
    await addTask(bob, "[fail] 验证失败");
    const bobPage = await newPage(browser, bob.sessionId);
    await bobPage.goto(`${CLIENT_URL}/demo-app`, { waitUntil: "networkidle2", timeout: 30_000 });
    await waitForText(bobPage, "可用额度：3");
    await clickGenerate(bobPage);
    await waitForText(bobPage, "本次未消耗额度", 20_000);
    await bobPage.waitForFunction(
      () => /可用额度：\s*3\b/.test(document.querySelector('[data-testid="available-credits"]')?.textContent ?? ""),
      { timeout: 15_000 },
    );
    assert.equal(await credits(bob), 3);
    await bobPage.screenshot({ path: `${screenshotsDir}/e2e-model-failure.png`, fullPage: true });
    log("A03 模型失败提示未消耗额度，余额保持 3");

    // ---------- A05：HTTP 并发 ----------
    const carol = await createAccount("carol");
    await addTask(carol, "并发任务");
    const concurrent = await Promise.all(
      Array.from({ length: 10 }, () => generate(carol)),
    );
    const succeeded = concurrent.filter((result) => result.status === 200 && result.body?.status === "succeeded");
    const insufficient = concurrent.filter((result) => result.status === 402);
    assert.equal(succeeded.length, 3, `A05 期望 3 个成功，实际 ${succeeded.length}`);
    assert.equal(insufficient.length, 7, `A05 期望 7 个额度不足，实际 ${insufficient.length}`);
    assert.equal(await credits(carol), 0);
    const planResults = await operation("get-plan-results", undefined, carol.sessionId);
    assert.equal(planResults.body.length, 3);
    log("A05 HTTP 10 并发：3 成功 / 7 额度不足，最终额度 0");

    log("PASS", `全部检查通过（run ${runId}）`);
  } finally {
    await browser.close();
    if (createdUserIds.length > 0) {
      await prisma.$transaction([
        prisma.planResult.deleteMany({ where: { userId: { in: createdUserIds } } }),
        prisma.task.deleteMany({ where: { userId: { in: createdUserIds } } }),
        prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }),
      ]);
    }
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`[e2e] FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
