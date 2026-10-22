import { chromium } from "playwright";

const base = "http://localhost:3000";
const user = "ui" + Date.now();
const outDir = "docs/assets";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

// 注册新账号（初始额度 3）
await page.goto(`${base}/signup`);
const usernameInput = page.locator('input[name="username"], input[placeholder*="sername" i]').first();
const passwordInput = page.locator('input[type="password"]').first();
await usernameInput.fill(user);
await passwordInput.fill("password123");
await page.locator('button[type="submit"], button:has-text("Sign up")').first().click();
await page.waitForURL("**/demo-app", { timeout: 15000 });

// 初始额度展示
await page.waitForSelector("text=剩余额度：3", { timeout: 15000 });
console.log("UI1 初始额度显示为 3 ✅");

// 添加任务
await page.fill("#description", "准备面试材料");
await page.click('button:has-text("添加任务")');
await page.waitForSelector("text=准备面试材料", { timeout: 10000 });
await page.screenshot({ path: `${outDir}/ui-before-generate.png` });

// 生成日程
await page.click('[data-testid="generate-schedule-button"]');
await page.waitForSelector("text=本次日程", { timeout: 20000 });
await page.waitForSelector("text=剩余额度：2", { timeout: 10000 });
console.log("UI2 生成成功，页面额度刷新为 2 ✅");
await page.screenshot({ path: `${outDir}/ui-after-generate.png`, fullPage: true });

await browser.close();
console.log("UI_VERIFY_OK");
