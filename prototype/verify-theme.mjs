import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectURL = new URL('.', import.meta.url);
const evidenceDir = new URL('./evidence/theme-qa/', projectURL);
const reportURL = new URL('./evidence/theme-qa/theme-qa.json', projectURL);
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:4310';
const moduleEntry = process.env.PLAYWRIGHT_MODULE_PATH;
const moduleURL = moduleEntry ? pathToFileURL(resolve(moduleEntry)).href : 'playwright';
const { chromium } = await import(moduleURL);

const cases = [];
const requests = [];
const blockedRequests = [];
const issues = [];
const contexts = [];
let activeCase;
let browser;
let browserChannel;
let fatalError;

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
  page.on('pageerror', (error) => issues.push({ page: label, type: 'pageerror', message: error.message }));
  page.on('console', (message) => {
    if (message.type() === 'error') issues.push({ page: label, type: 'console.error', message: message.text() });
  });
}

async function capture(page, name, { fullPage = true } = {}) {
  const path = new URL(name, evidenceDir);
  await page.screenshot({ path: fileURLToPath(path), fullPage });
  activeCase.screenshots.push(fileURLToPath(path));
}

function installTransitionProbe(disableNative) {
  window.__themeQaTransitions = [];
  window.__themeQaRootAnimations = [];
  const nativeAnimate = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    const animation = nativeAnimate.call(this, keyframes, options);
    if (this === document.documentElement && options?.pseudoElement) {
      let frames = [];
      try {
        const input = Array.isArray(keyframes) ? keyframes : [keyframes];
        frames = input.map((frame) => ({ clipPath: frame.clipPath || null }));
      } catch { /* Keep the animation record even if keyframes are not serializable. */ }
      window.__themeQaRootAnimations.push({
        animation,
        pseudoElement: options.pseudoElement,
        duration: options.duration,
        easing: options.easing,
        frames,
      });
    }
    return animation;
  };

  const nativeMethod = document.startViewTransition;
  window.__themeQaNativeAvailable = !disableNative && typeof nativeMethod === 'function';
  window.__themeQaProbeInstalled = false;

  if (disableNative) {
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    return;
  }
  if (typeof nativeMethod !== 'function') return;

  try {
    document.startViewTransition = function (callback, options) {
      const transition = nativeMethod.call(document, callback, options);
      const record = { transition, ready: false, finished: false, readyError: null, finishedError: null };
      window.__themeQaTransitions.push(record);
      transition.ready.then(() => { record.ready = true; }, (error) => { record.readyError = String(error); });
      record.settled = transition.finished.then(
        () => { record.finished = true; },
        (error) => { record.finishedError = String(error); },
      );
      return transition;
    };
    window.__themeQaProbeInstalled = document.startViewTransition !== nativeMethod;
  } catch {
    window.__themeQaProbeInstalled = false;
  }
}

async function newPage({ label, viewport = { width: 1365, height: 920 }, reducedMotion = 'no-preference', disableNative = false, appScriptGate = null }) {
  const context = await browser.newContext({ viewport, reducedMotion });
  contexts.push(context);
  const origin = new URL(baseURL);
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (appScriptGate?.holdNext && url.origin === origin.origin && /\/app\.js$/i.test(url.pathname)) {
      appScriptGate.holdNext = false;
      appScriptGate.heldUrl = url.href;
      appScriptGate.signalHeld(url.href);
      await new Promise((resolve) => { appScriptGate.resume = resolve; });
      appScriptGate.resume = null;
    }
    if (url.origin === origin.origin) return route.continue();
    blockedRequests.push({ page: label, method: route.request().method(), url: url.href });
    return route.abort();
  });
  await context.addInitScript(installTransitionProbe, disableNative);
  const page = await context.newPage();
  monitor(page, label);
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.locator('#theme-toggle').waitFor({ state: 'visible' });
  return { context, page };
}

async function waitForTheme(page, theme, timeout = 3000) {
  await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme, { timeout });
}

async function modeSnapshot(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    const bodyStyle = getComputedStyle(document.body);
    const panelStyle = getComputedStyle(document.querySelector('.task-panel'));
    const button = document.querySelector('#theme-toggle');
    return {
      theme: root.dataset.theme || '',
      pageColor: style.getPropertyValue('--page').trim(),
      surfaceColor: style.getPropertyValue('--surface').trim(),
      pageBackground: style.backgroundColor,
      bodyBackground: bodyStyle.backgroundColor,
      panelBackground: panelStyle.backgroundColor,
      buttonLabel: button?.getAttribute('aria-label') || '',
      buttonTitle: button?.getAttribute('title') || '',
    };
  });
}

function rgbSum(value) {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  return channels?.length === 3 ? channels.reduce((sum, channel) => sum + channel, 0) : NaN;
}

function checkMode(snapshot, expectedTheme, prefix) {
  const target = expectedTheme === 'dark' ? /浅色|light/i : /深色|dark/i;
  const opposite = expectedTheme === 'dark' ? /深色|dark/i : /浅色|light/i;
  const backgroundSum = rgbSum(snapshot.pageBackground);
  const panelSum = rgbSum(snapshot.panelBackground);
  check(snapshot.theme === expectedTheme, `${prefix}: data-theme=${expectedTheme}`, snapshot);
  check(expectedTheme === 'dark' ? backgroundSum < 300 : backgroundSum > 600, `${prefix}: 页面实际背景符合主题`, snapshot.pageBackground);
  check(expectedTheme === 'dark' ? panelSum < 400 : panelSum > 600, `${prefix}: 面板实际配色符合主题`, snapshot.panelBackground);
  check(target.test(snapshot.buttonLabel) && !opposite.test(snapshot.buttonLabel), `${prefix}: aria-label 指向下一步主题`, snapshot.buttonLabel);
  check(target.test(snapshot.buttonTitle) && !opposite.test(snapshot.buttonTitle), `${prefix}: title 指向下一步主题`, snapshot.buttonTitle);
}

async function transitionSnapshot(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const record = window.__themeQaTransitions?.at(-1);
    const rect = document.querySelector('#theme-toggle')?.getBoundingClientRect();
    const pseudo = (selector) => {
      try {
        const style = getComputedStyle(root, selector);
        return { clipPath: style.clipPath, animationName: style.animationName, animationDuration: style.animationDuration };
      } catch (error) {
        return { error: String(error) };
      }
    };
    const animations = document.getAnimations().map((animation) => {
      const effect = animation.effect;
      const pseudoElement = effect?.pseudoElement || '';
      let clipPath = '';
      if (pseudoElement.startsWith('::view-transition')) {
        try { clipPath = getComputedStyle(root, pseudoElement).clipPath; } catch { /* Browser may omit pseudo style access. */ }
      }
      return {
        pseudoElement,
        playState: animation.playState,
        progress: effect?.getComputedTiming?.().progress ?? null,
        clipPath,
      };
    }).filter((animation) => animation.pseudoElement.startsWith('::view-transition'));
    const rootAnimations = (window.__themeQaRootAnimations || []).map((record) => {
      let currentClipPath = '';
      try { currentClipPath = getComputedStyle(root, record.pseudoElement).clipPath; } catch { /* Keep captured keyframes for diagnostics. */ }
      return {
        pseudoElement: record.pseudoElement,
        duration: record.duration,
        easing: record.easing,
        frames: record.frames,
        playState: record.animation.playState,
        currentTime: typeof record.animation.currentTime === 'number' ? record.animation.currentTime : null,
        progress: record.animation.effect?.getComputedTiming?.().progress ?? null,
        currentClipPath,
      };
    });
    return {
      nativeAvailable: Boolean(window.__themeQaNativeAvailable),
      probeInstalled: Boolean(window.__themeQaProbeInstalled),
      transitionCount: window.__themeQaTransitions?.length || 0,
      ready: Boolean(record?.ready),
      readyError: record?.readyError || null,
      finished: Boolean(record?.finished),
      finishedError: record?.finishedError || null,
      themeTransitionAttribute: root.dataset.themeTransition || '',
      animations,
      rootAnimations,
      newRoot: pseudo('::view-transition-new(root)'),
      oldRoot: pseudo('::view-transition-old(root)'),
      buttonCenter: rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null,
    };
  });
}

async function awaitLatestTransition(page, timeout = 2500) {
  await page.evaluate(async (waitMs) => {
    const record = window.__themeQaTransitions?.at(-1);
    if (!record) return;
    await Promise.race([
      record.transition.ready.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, waitMs)),
    ]);
  }, timeout);
}

async function awaitLatestTransitionFinished(page, timeout = 2500) {
  await page.evaluate(async (waitMs) => {
    const record = window.__themeQaTransitions?.at(-1);
    if (!record) return;
    await Promise.race([
      record.settled,
      new Promise((resolve) => setTimeout(resolve, waitMs)),
    ]);
  }, timeout);
}

async function waitForRootAnimation(page, timeout = 2500) {
  await page.waitForFunction(() => {
    const record = window.__themeQaRootAnimations?.at(-1);
    return record?.pseudoElement === '::view-transition-new(root)' && record.animation.playState === 'running';
  }, undefined, { timeout });
}

async function pauseRootAnimationAt(page, milliseconds) {
  return page.evaluate(async (time) => {
    const record = window.__themeQaRootAnimations?.at(-1);
    if (!record) return null;
    record.animation.pause();
    record.animation.currentTime = time;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      playState: record.animation.playState,
      currentTime: record.animation.currentTime,
      clipPath: getComputedStyle(document.documentElement, record.pseudoElement).clipPath,
    };
  }, milliseconds);
}

async function resumeRootAnimation(page) {
  await page.evaluate(() => window.__themeQaRootAnimations?.at(-1)?.animation.play());
}

async function awaitLatestRootAnimationFinished(page, timeout = 2500) {
  await page.evaluate(async (waitMs) => {
    const record = window.__themeQaRootAnimations?.at(-1);
    if (!record) return;
    await Promise.race([
      record.animation.finished.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, waitMs)),
    ]);
  }, timeout);
}

async function waitForThemeSettled(page, timeout = 4000) {
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-theme-transition'), undefined, { timeout });
  await awaitLatestTransitionFinished(page, timeout);
  await awaitLatestRootAnimationFinished(page, timeout);
  await page.waitForFunction(() => {
    const lastTransition = window.__themeQaTransitions?.at(-1);
    const lastRootAnimation = window.__themeQaRootAnimations?.at(-1);
    const transitionFinished = !lastTransition || lastTransition.finished || Boolean(lastTransition.finishedError);
    const animationFinished = !lastRootAnimation || ['finished', 'idle'].includes(lastRootAnimation.animation.playState);
    return !document.documentElement.hasAttribute('data-theme-transition') && transitionFinished && animationFinished;
  }, undefined, { timeout });
  return transitionSnapshot(page);
}

function circleClip(snapshot) {
  const clips = [
    snapshot.newRoot?.clipPath,
    snapshot.oldRoot?.clipPath,
    ...snapshot.animations.map((animation) => animation.clipPath),
    ...snapshot.rootAnimations.map((animation) => animation.currentClipPath),
  ];
  return clips.find((clipPath) => typeof clipPath === 'string' && /circle\(/i.test(clipPath)) || '';
}

function circleOrigin(clipPath) {
  const match = clipPath.match(/circle\([^)]*?\bat\s+(-?[\d.]+)px\s+(-?[\d.]+)px/i);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

async function launchBrowser() {
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
  } catch (error) {
    failures.push(`playwright chromium: ${error.message}`);
    throw new Error(`Could not launch Edge, Chrome, or installed Playwright Chromium. ${failures.join(' | ')}`);
  }
}

try {
  await mkdir(evidenceDir, { recursive: true });
  await launchBrowser();

  await runCase('浅色与深色往返、实际配色和无障碍名称', async () => {
    const { page } = await newPage({ label: 'theme-roundtrip' });
    const toggle = page.locator('#theme-toggle');
    checkMode(await modeSnapshot(page), 'light', '初始浅色');
    await capture(page, 'theme-light-initial.png');

    const nativeAvailable = await page.evaluate(() => window.__themeQaNativeAvailable);
      await toggle.click();
    await waitForTheme(page, 'dark');
    const dark = await modeSnapshot(page);
    checkMode(dark, 'dark', '切换深色');

    if (nativeAvailable) {
      await awaitLatestTransition(page);
      await waitForRootAnimation(page);
      const during = await transitionSnapshot(page);
      check(during.probeInstalled && during.transitionCount > 0, '原生 ViewTransition 已被调用并可观测', during);
      check(during.ready, 'ViewTransition 进入 ready 动画阶段', during);
      const runningRootAnimation = during.rootAnimations.find((animation) =>
        animation.pseudoElement === '::view-transition-new(root)' && animation.playState === 'running');
      check(Boolean(runningRootAnimation), '新页面 root 圆形扩散动画正在运行', during.rootAnimations);
      check(runningRootAnimation?.duration === 500, '扩散动画时长为 500ms', runningRootAnimation);
      const frame = await pauseRootAnimationAt(page, 250);
      const midpoint = await transitionSnapshot(page);
      await capture(page, 'theme-dark-transition-midpoint.png', { fullPage: false });
      check(frame?.playState === 'paused' && Math.abs(frame.currentTime - 250) < 5, '动画已暂停在 250ms 中途帧', frame);
      const clipPath = circleClip(midpoint) || frame?.clipPath || '';
      check(Boolean(clipPath), '中途伪元素实际使用 circle 裁切', midpoint);
      const origin = circleOrigin(clipPath) || circleOrigin(runningRootAnimation?.frames.map((frameItem) => frameItem.clipPath || '').join(' '));
      check(Boolean(origin), 'circle 裁切暴露按钮中心坐标', { clipPath, origin, keyframes: runningRootAnimation?.frames, buttonCenter: midpoint.buttonCenter });
      if (origin && midpoint.buttonCenter) {
        const distance = Math.hypot(origin.x - midpoint.buttonCenter.x, origin.y - midpoint.buttonCenter.y);
        check(distance <= 4, 'circle 扩散起点位于切换按钮中心', { origin, buttonCenter: midpoint.buttonCenter, distance });
      }
      await resumeRootAnimation(page);
      await awaitLatestTransitionFinished(page);
      await awaitLatestRootAnimationFinished(page);
      const after = await transitionSnapshot(page);
      const lingering = after.animations.filter((animation) => animation.playState === 'running');
      check(after.finished, 'ViewTransition 正常结束', after);
      check(after.themeTransitionAttribute === '', '动画结束后清除 active 标记', after.themeTransitionAttribute);
      check(lingering.length === 0 && after.rootAnimations.every((animation) => animation.playState !== 'running') && !circleClip(after), '结束后无残留扩散遮罩或动画', after);
    } else {
      check(true, '当前浏览器无原生 ViewTransition，跳过原生动画断言', { nativeAvailable });
      const settled = await waitForThemeSettled(page);
      check(settled.themeTransitionAttribute === '', '无原生 ViewTransition 的最终状态无 active 标记', settled.themeTransitionAttribute);
      await capture(page, 'theme-dark-no-native-transition.png');
    }

    await toggle.click();
    await waitForTheme(page, 'light');
    checkMode(await modeSnapshot(page), 'light', '切回浅色');
    if (nativeAvailable) {
      await awaitLatestTransition(page);
      await waitForRootAnimation(page);
      const reverse = await transitionSnapshot(page);
      const reverseAnimation = reverse.rootAnimations.find((animation) =>
        animation.pseudoElement === '::view-transition-new(root)' && animation.playState === 'running');
      const reverseClip = reverseAnimation?.frames.map((frameItem) => frameItem.clipPath || '').join(' ') || '';
      const reverseOrigin = circleOrigin(reverseClip);
      check(Boolean(reverseAnimation), '反向切换也启动 root 扩散动画', reverse.rootAnimations);
      check(Boolean(reverseOrigin) && reverse.buttonCenter && Math.hypot(reverseOrigin.x - reverse.buttonCenter.x, reverseOrigin.y - reverse.buttonCenter.y) <= 4,
        '反向切换也从按钮中心开始', { reverseOrigin, buttonCenter: reverse.buttonCenter, keyframes: reverseAnimation?.frames });
      const settled = await waitForThemeSettled(page);
      check(settled.themeTransitionAttribute === '', '反向切换完成后清除 active 标记', settled.themeTransitionAttribute);
    } else {
      await waitForThemeSettled(page);
    }
    await capture(page, 'theme-light-restored.png');
  });

  await runCase('刷新后保留当前主题', async () => {
    let signalHeld;
    const heldScript = new Promise((resolve) => { signalHeld = resolve; });
    const appScriptGate = { holdNext: false, signalHeld, heldUrl: null, resume: null };
    const { page } = await newPage({ label: 'theme-refresh', appScriptGate });
    await page.locator('#theme-toggle').click();
    await waitForTheme(page, 'dark');
    appScriptGate.holdNext = true;
    await page.reload({ waitUntil: 'commit' });
    const heldURL = await Promise.race([
      heldScript,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for app.js route hold')), 3000)),
    ]);
    check(heldURL === new URL('/app.js', baseURL).href, '刷新时已阻断应用脚本请求', heldURL);
    await page.waitForFunction(() => {
      return document.documentElement.dataset.theme === 'dark' &&
        getComputedStyle(document.documentElement).backgroundColor === 'rgb(16, 25, 35)' &&
        document.styleSheets.length > 0;
    }, undefined, { timeout: 3000 });
    const firstPaint = await modeSnapshot(page);
    check(firstPaint.theme === 'dark' && firstPaint.pageBackground === 'rgb(16, 25, 35)', 'app.js 尚未执行时首屏已显示深色背景', firstPaint);
    const preScriptSettled = await waitForThemeSettled(page);
    check(preScriptSettled.themeTransitionAttribute === '', 'app.js 执行前首屏无主题切换残留标记', preScriptSettled.themeTransitionAttribute);
    await capture(page, 'theme-refresh-dark-before-appjs.png', { fullPage: false });
    appScriptGate.resume?.();
    await page.waitForFunction(() => document.querySelector('#theme-toggle')?.getAttribute('aria-label') === '切换浅色模式', undefined, { timeout: 3000 });
    await waitForTheme(page, 'dark');
    checkMode(await modeSnapshot(page), 'dark', '刷新后深色');
    const settled = await waitForThemeSettled(page);
    check(settled.themeTransitionAttribute === '', '刷新后最终主题状态无 active 标记', settled.themeTransitionAttribute);
    await capture(page, 'theme-dark-after-refresh.png');
  });

  await runCase('快速连续切换 3 次后主题与点击次数一致', async () => {
    const { page } = await newPage({ label: 'theme-rapid-toggle' });
    const toggle = page.locator('#theme-toggle');
    for (let index = 0; index < 3; index += 1) await toggle.click();
    await waitForTheme(page, 'dark', 5000);
    await page.evaluate(async () => {
      const records = window.__themeQaTransitions || [];
      await Promise.race([
        Promise.allSettled(records.map((record) => record.settled)),
        new Promise((resolve) => setTimeout(resolve, 3500)),
      ]);
    });
    const settled = await waitForThemeSettled(page, 5000);
    check(settled.themeTransitionAttribute === '', '快速切换最终状态已清除 active 标记', settled.themeTransitionAttribute);
    checkMode(await modeSnapshot(page), 'dark', '三次点击后应为深色');
    check(await toggle.isEnabled(), '快速切换后按钮仍可操作');
    const running = (await transitionSnapshot(page)).animations.filter((animation) => animation.playState === 'running');
    check(running.length === 0, '快速切换全部完成后无卡住的 ViewTransition', running);
    await capture(page, 'theme-rapid-three-dark.png');
  });

  await runCase('prefers-reduced-motion 下不启用圆形扩散', async () => {
    const { page } = await newPage({ label: 'theme-reduced-motion', reducedMotion: 'reduce' });
    const reduced = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
    check(reduced, '浏览器模拟 prefers-reduced-motion: reduce');
    await page.locator('#theme-toggle').click();
    await waitForTheme(page, 'dark');
    checkMode(await modeSnapshot(page), 'dark', '减少动态效果下切换深色');
    await awaitLatestTransition(page, 700);
    const transition = await transitionSnapshot(page);
    const runningCircle = transition.animations.some((animation) =>
      animation.playState === 'running' && animation.pseudoElement.includes('view-transition-new(root)') && /circle\(/i.test(animation.clipPath));
    check(!runningCircle, '减少动态效果时没有运行中的圆形扩散', transition);
    const settled = await waitForThemeSettled(page);
    check(settled.themeTransitionAttribute === '', '减少动态效果最终状态无 active 标记', settled.themeTransitionAttribute);
    await capture(page, 'theme-reduced-motion.png');
  });

  await runCase('缺少 document.startViewTransition 时仍可切换', async () => {
    const { page } = await newPage({ label: 'theme-fallback', disableNative: true });
    const apiMissing = await page.evaluate(() => typeof document.startViewTransition === 'undefined');
    check(apiMissing, '隔离页已禁用 document.startViewTransition');
    await page.locator('#theme-toggle').click();
    await waitForTheme(page, 'dark');
    checkMode(await modeSnapshot(page), 'dark', '无原生 API fallback');
    const count = await page.evaluate(() => window.__themeQaTransitions.length);
    check(count === 0, 'fallback 未调用原生 ViewTransition', { transitionCount: count });
    const settled = await waitForThemeSettled(page);
    check(settled.themeTransitionAttribute === '', 'fallback 最终状态无 active 标记', settled.themeTransitionAttribute);
    await capture(page, 'theme-fallback-dark.png');
  });

  await runCase('375px 手机视口可切换且无横向溢出', async () => {
    const { page } = await newPage({ label: 'theme-mobile-375', viewport: { width: 375, height: 812 } });
    const before = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    check(before.scrollWidth <= before.width, '375px 初始布局无水平溢出', before);
    await page.locator('#theme-toggle').click();
    await waitForTheme(page, 'dark');
    const settled = await waitForThemeSettled(page);
    check(settled.themeTransitionAttribute === '', '375px 深色截图前 transition 标记已移除', settled.themeTransitionAttribute);
    const finalMode = await modeSnapshot(page);
    checkMode(finalMode, 'dark', '375px 下点击主题按钮');
    check(finalMode.theme === 'dark', '375px 深色截图前主题为 dark', finalMode.theme);
    check(rgbSum(finalMode.pageBackground) < 300, '375px 深色截图前页面根背景实际为深色', finalMode.pageBackground);
    const after = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    check(after.scrollWidth <= after.width, '切换后仍无水平溢出', after);
    check(await page.locator('#theme-toggle').isEnabled(), '375px 下主题按钮可操作');
    await capture(page, 'theme-mobile-375-dark.png');
  });

  await runCase('生成过程中切换主题不会取消或重复扣额度', async () => {
    const { page } = await newPage({ label: 'theme-generation-in-progress' });
    const generate = page.getByTestId('generate-button');
    await page.getByTestId('scenario-normal').click();
    await generate.click();
    await page.locator('#generate-spinner').waitFor({ state: 'visible', timeout: 2500 });
    const before = await page.getByTestId('credit-balance').innerText();
    await page.locator('#theme-toggle').click();
    await waitForTheme(page, 'dark');
    const settled = await waitForThemeSettled(page);
    check(settled.themeTransitionAttribute === '', '生成中主题切换完成后清除 active 标记', settled.themeTransitionAttribute);
    checkMode(await modeSnapshot(page), 'dark', '生成过程中主题切换结束');
    check(await page.locator('#generate-spinner').isVisible(), '主题切换期间生成仍在进行');
    await capture(page, 'theme-generation-in-progress.png');
    await page.waitForFunction(() => !document.querySelector('#generate-button')?.disabled, undefined, { timeout: 6000 });
    await waitForTheme(page, 'dark');
    const after = await page.getByTestId('credit-balance').innerText();
    check(/3/.test(before), '生成开始前额度为 3', before.trim());
    check(/2/.test(after), '生成完成后仅消耗 1 次额度', after.trim());
    check(await page.getByTestId('schedule-result').isVisible(), '主题切换没有取消生成结果');
    check(await page.getByTestId('schedule-result').locator('.plan-item').count() === 2, '只生成一份包含原两项任务的日程');
    checkMode(await modeSnapshot(page), 'dark', '生成完成后仍为深色');
    const completeSettled = await waitForThemeSettled(page);
    check(completeSettled.themeTransitionAttribute === '', '生成完成截图前主题状态已稳定', completeSettled.themeTransitionAttribute);
    await capture(page, 'theme-generation-complete.png');
  });

  await runCase('页面运行未访问外部服务且没有浏览器脚本错误', async () => {
    check(blockedRequests.length === 0, '没有尝试访问外部服务', blockedRequests);
    const writes = requests.filter((request) => !['GET', 'HEAD'].includes(request.method));
    check(writes.length === 0, '没有写入型网络请求', writes);
    check(issues.length === 0, '没有 pageerror 或 console.error', issues);
  });
} catch (error) {
  fatalError = String(error?.stack || error);
  console.error(fatalError);
} finally {
  for (const context of contexts) await context.close().catch(() => {});
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
    blockedExternalRequests: blockedRequests,
    browserIssues: issues,
  };
  try {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(reportURL, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch (error) {
    fatalError ||= `Could not write theme QA report: ${error.message}`;
  }
}

if (fatalError || cases.some((item) => item.status !== 'passed')) process.exitCode = 1;
