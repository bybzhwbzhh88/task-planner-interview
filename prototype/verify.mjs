import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = new URL('.', import.meta.url);
const evidenceDir = new URL('./evidence/', here);
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:4310';
const playwrightEntry = process.env.PLAYWRIGHT_MODULE_PATH;
const playwrightURL = playwrightEntry
  ? pathToFileURL(resolve(playwrightEntry)).href
  : 'playwright';

const { chromium } = await import(playwrightURL);
const cases = [];
const requests = [];
const issues = [];
let activeCase;
let browser;
let browserChannel;

function check(condition, title, details) {
  const result = { title, passed: Boolean(condition) };
  if (details !== undefined) result.details = details;
  activeCase.checks.push(result);
  if (!condition) throw new Error(title);
}

async function runCase(title, action) {
  activeCase = { title, status: 'running', checks: [], screenshots: [] };
  try {
    await action();
    activeCase.status = 'passed';
  } catch (error) {
    activeCase.status = 'failed';
    activeCase.error = String(error?.stack || error);
  }
  cases.push(activeCase);
  console.log(`${activeCase.status.toUpperCase()}: ${title}`);
  if (activeCase.error) console.error(activeCase.error.split('\n')[0]);
}

function monitor(page, label) {
  page.on('request', (request) => {
    requests.push({ page: label, method: request.method(), url: request.url() });
  });
  page.on('pageerror', (error) => {
    issues.push({ page: label, type: 'pageerror', message: error.message });
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      issues.push({ page: label, type: 'console.error', message: message.text() });
    }
  });
}

async function screenshot(page, filename) {
  const path = new URL(filename, evidenceDir);
  await page.screenshot({ path: fileURLToPath(path), fullPage: true });
  activeCase.screenshots.push(`evidence/${filename}`);
}

async function waitForBalance(page, expected, timeout = 8000) {
  await page.waitForFunction((value) => {
    const text = document.querySelector('[data-testid="credit-balance"]')?.textContent || '';
    const match = text.match(/\d+/);
    return match && Number(match[0]) === value;
  }, expected, { timeout });
}

async function waitForFeedback(page, pattern, timeout = 8000) {
  await page.waitForFunction((source) => {
    const title = document.querySelector('[data-testid="feedback-title"]')?.textContent || '';
    const body = document.querySelector('[data-testid="feedback-body"]')?.textContent || '';
    return new RegExp(source).test(`${title} ${body}`);
  }, pattern, { timeout });
}

async function readSchedule(page) {
  const result = page.getByTestId('schedule-result');
  return (await result.isVisible()) ? (await result.innerText()).trim() : '';
}

async function selectScenario(page, testId, expectedBalance) {
  await page.getByTestId(testId).click();
  await waitForBalance(page, expectedBalance);
}

function suspiciousRequests() {
  const origin = new URL(baseURL).origin;
  return requests.filter((request) => {
    const url = new URL(request.url);
    return url.origin !== origin ||
      !['GET', 'HEAD'].includes(request.method) ||
      /\/(api|graphql|trpc|auth|session|billing|credits?)(\/|\?|#|$)/i.test(url.pathname + url.search + url.hash);
  });
}

async function launchSystemBrowser() {
  const failures = [];
  for (const channel of ['msedge', 'chrome']) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      browserChannel = channel;
      return;
    } catch (error) {
      failures.push(`${channel}: ${error.message}`);
    }
  }
  try {
    browser = await chromium.launch({ headless: true });
    browserChannel = 'playwright-chromium';
    return;
  } catch (error) {
    failures.push(`playwright chromium: ${error.message}`);
  }
  throw new Error(`Could not launch Edge, Chrome, or installed Playwright Chromium. ${failures.join(' | ')}`);
}

let fatalError;
try {
  await mkdir(evidenceDir, { recursive: true });
  await launchSystemBrowser();

  const context = await browser.newContext({ viewport: { width: 1365, height: 920 } });
  const page = await context.newPage();
  monitor(page, 'desktop');
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('generate-button').waitFor({ state: 'visible' });

  await runCase('初始额度和示例任务', async () => {
    const balance = await page.getByTestId('credit-balance').innerText();
    const taskCount = await page.locator('[aria-label^="删除任务："]').count();
    check(/3/.test(balance), '初始额度为 3 次', balance.trim());
    check(taskCount === 2, '初始预置 2 条示例任务', { taskCount });
    check(await page.getByTestId('generate-button').isEnabled(), '存在任务时可开始生成');
    await screenshot(page, 'desktop-initial.png');
  });

  await runCase('正常生成、加载防重复和刷新保留', async () => {
    const generate = page.getByTestId('generate-button');
    await selectScenario(page, 'scenario-normal', 3);
    await generate.click();
    check(await generate.isDisabled(), '生成期间按钮禁用');
    await waitForBalance(page, 2);
    await waitForFeedback(page, '成功|已生成|已更新');
    const scheduleText = await readSchedule(page);
    check(scheduleText.length > 0, '成功后展示日程结果');
    check(/2/.test(await page.getByTestId('credit-balance').innerText()), '成功只消耗 1 次额度');
    check(await generate.isEnabled(), '生成完成后可再次操作');
    await screenshot(page, 'desktop-success.png');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('generate-button').waitFor({ state: 'visible' });
    await waitForBalance(page, 2);
    check((await readSchedule(page)) === scheduleText, '刷新后保留已生成结果');
    check(await page.getByTestId('schedule-result').isVisible(), '刷新后结果仍可见');
  });

  await runCase('明确失败保留额度和旧日程，主动重试成功', async () => {
    const generate = page.getByTestId('generate-button');
    const priorSchedule = await readSchedule(page);
    await selectScenario(page, 'scenario-fail', 3);
    await generate.click();
    check(await generate.isDisabled(), '失败尝试进行中按钮禁用');
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-testid="generate-button"]');
      const title = document.querySelector('[data-testid="feedback-title"]')?.textContent || '';
      return button && !button.disabled && title.startsWith('生成失败');
    }, undefined, { timeout: 8000 });
    check(/3/.test(await page.getByTestId('credit-balance').innerText()), '明确失败不消耗额度');
    check((await readSchedule(page)) === priorSchedule, '失败后保留上一份日程');
    check(await generate.isEnabled(), '明确失败后允许主动重试');
    await screenshot(page, 'desktop-failure.png');

    await generate.click();
    check(await generate.isDisabled(), '主动重试期间按钮禁用');
    await waitForBalance(page, 2);
    await waitForFeedback(page, '成功|已生成|已更新');
    check((await readSchedule(page)).length > 0, '重试成功后有日程结果');
    check(/2/.test(await page.getByTestId('credit-balance').innerText()), '重试成功只扣 1 次，余额为 2');
  });

  await runCase('最后 1 次成功后额度归零', async () => {
    await selectScenario(page, 'scenario-last', 1);
    await page.getByTestId('generate-button').click();
    await waitForBalance(page, 0);
    await waitForFeedback(page, '成功|已生成|已更新');
    check(await page.getByTestId('generate-button').isDisabled(), '额度归零后生成按钮禁用');
    await screenshot(page, 'desktop-zero-after-last.png');
  });

  await runCase('额度用完时直接拦截', async () => {
    await selectScenario(page, 'scenario-zero', 0);
    check(await page.getByTestId('generate-button').isDisabled(), '额度为 0 时生成按钮禁用');
    await screenshot(page, 'desktop-zero.png');
  });

  await runCase('未知结果等待核对且不重复扣费', async () => {
    await selectScenario(page, 'scenario-unknown', 3);
    const generate = page.getByTestId('generate-button');
    await generate.click();
    await waitForFeedback(page, '结果尚未确认');
    const feedback = `${await page.getByTestId('feedback-title').innerText()} ${await page.getByTestId('feedback-body').innerText()}`;
    check(await generate.isDisabled(), '结果待确认时禁止再次生成');
    check(!/未扣|不扣|没有扣|不会扣|额度保留/.test(feedback), '待确认反馈不宣称额度未扣', feedback.trim());
    await screenshot(page, 'desktop-pending.png');

    await page.getByTestId('check-result-button').click();
    await waitForBalance(page, 2);
    await waitForFeedback(page, '成功|已找回|已确认|已生成');
    check((await readSchedule(page)).length > 0, '核对成功后找回日程');
    check(/2/.test(await page.getByTestId('credit-balance').innerText()), '核对后余额为 2，未重复扣费');
  });

  await runCase('删除全部任务后禁用，新增任务后恢复，零时长无效', async () => {
    await page.getByTestId('reset-demo').click();
    await waitForBalance(page, 3);
    const deleteButtons = page.locator('[aria-label^="删除任务："]');
    while (await deleteButtons.count()) await deleteButtons.first().click();
    check(await page.getByTestId('tasks-list').innerText().then((text) => text.trim().length === 0), '删除后任务列表为空');
    check(await page.getByTestId('generate-button').isDisabled(), '无任务时生成按钮禁用');

    const description = '验收新增任务';
    await page.getByTestId('task-input').fill(description);
    await page.getByTestId('task-submit').click();
    check(await page.getByTestId('tasks-list').getByText(description, { exact: true }).isVisible(), '新增任务显示在列表');
    check(await page.getByTestId('generate-button').isEnabled(), '新增任务后可生成');

    const scheduleBeforeInvalid = await readSchedule(page);
    await page.locator('#available-hours').fill('0');
    check(await page.getByTestId('generate-button').isDisabled(), 'available-hours 为 0 时阻止生成');
    check((await readSchedule(page)) === scheduleBeforeInvalid, '无效时长未改变已有日程');
  });

  await runCase('375px 手机布局无横向溢出且按钮可操作', async () => {
    const mobileContext = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1 });
    const mobile = await mobileContext.newPage();
    monitor(mobile, 'mobile-375');
    await mobile.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await mobile.getByTestId('generate-button').waitFor({ state: 'visible' });
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check(!overflow, '375px 页面无水平溢出', await mobile.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })));
    await screenshot(mobile, 'mobile-375.png');
    await mobile.getByTestId('generate-button').click();
    await waitForBalance(mobile, 2);
    check((await readSchedule(mobile)).length > 0, '手机端生成按钮可操作并展示结果');
    await mobileContext.close();
  });

  await runCase('生成中包装真实按钮文本节点后成功完成且无脚本错误', async () => {
    const isolated = await context.newPage();
    monitor(isolated, 'isolated-text-wrapper');
    await isolated.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await isolated.getByTestId('generate-button').waitFor({ state: 'visible' });
    await selectScenario(isolated, 'scenario-normal', 3);
    const issueStart = issues.length;
    await isolated.getByTestId('generate-button').click();
    await isolated.locator('#generate-spinner').waitFor({ state: 'visible', timeout: 3000 });
    const wrappedInfo = await isolated.locator('#generate-label').evaluate((label) => {
      const textNodes = Array.from(label.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      const wrapperTagNames = [];
      for (const textNode of textNodes) {
        const wrapper = document.createElement('font');
        wrapper.dataset.qaFontWrapper = 'true';
        wrapper.style.fontFamily = 'sans-serif';
        label.replaceChild(wrapper, textNode);
        wrapper.appendChild(textNode);
        wrapperTagNames.push(wrapper.tagName);
      }
      return { replacedNodes: textNodes.length, wrapperTagNames, text: label.textContent };
    });
    check(wrappedInfo.replacedNodes > 0, '已包装 #generate-label 中真实文本节点', wrappedInfo);
    check(wrappedInfo.wrapperTagNames.every((tagName) => tagName === 'FONT'), '实际包装元素为 font', wrappedInfo.wrapperTagNames);
    await screenshot(isolated, 'desktop-font-wrap-generating.png');

    await waitForBalance(isolated, 2);
    await waitForFeedback(isolated, '日程已生成|本次消耗 1 次');
    check(/2/.test(await isolated.getByTestId('credit-balance').innerText()), '包装文本节点后生成正常完成，余额为 2');
    check(await isolated.getByTestId('schedule-result').isVisible(), '包装文本节点后日程结果可见');
    check(await isolated.getByRole('heading', { name: 'AI 任务规划' }).isVisible(), '页面未进入根错误或崩溃态');
    await screenshot(isolated, 'desktop-font-wrap-complete.png');

    const newErrors = issues.slice(issueStart);
    check(newErrors.length === 0, '包装文本节点后没有 pageerror 或 console.error', newErrors);
    check(!newErrors.some((issue) => /removeChild/i.test(issue.message)), '没有 removeChild 错误', newErrors);
    await isolated.close();
  });

  await runCase('无真实 API 请求且无浏览器脚本错误', async () => {
    const suspicious = suspiciousRequests();
    check(suspicious.length === 0, '没有远程、写入或 API 类网络请求', suspicious);
    check(issues.length === 0, '没有 pageerror 或 console.error', issues);
  });

  await context.close();
} catch (error) {
  fatalError = String(error?.stack || error);
  console.error(fatalError);
} finally {
  if (browser) await browser.close().catch(() => {});
  const report = {
    generatedAt: new Date().toISOString(),
    baseURL,
    browser: browserChannel || null,
    status: fatalError || cases.some((item) => item.status !== 'passed') ? 'failed' : 'passed',
    fatalError: fatalError || null,
    summary: {
      passed: cases.filter((item) => item.status === 'passed').length,
      failed: cases.filter((item) => item.status === 'failed').length,
      total: cases.length,
    },
    cases,
    requests,
    browserIssues: issues,
  };
  try {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(new URL('./evidence/browser-qa.json', here), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch (error) {
    fatalError ||= `Could not write evidence report: ${error.message}`;
  }
}

if (fatalError || cases.some((item) => item.status !== 'passed')) process.exitCode = 1;
