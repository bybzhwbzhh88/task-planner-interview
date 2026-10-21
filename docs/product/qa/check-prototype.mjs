// Browser checks for the local product prototype, not the real Wasp application.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright');
const base=process.env.PROTOTYPE_URL||'http://127.0.0.1:18765/prototype/index.html';
const out=fileURLToPath(new URL('./results.json',import.meta.url));
const assets=fileURLToPath(new URL('../assets/',import.meta.url));
const key='task-planner-product-demo-v1';
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1100},locale:'zh-CN'});
context.setDefaultTimeout(8000);
// Hold provider completion until the explicit demo control is used. The product
// keeps its normal 4-second timer; this fixture only applies to this test context.
const fixtureNow=Date.now();
await context.addInitScript(({now})=>{Date.now=()=>now;},{now:fixtureNow});
const page=await context.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(base);await page.waitForFunction(()=>document.querySelector('#debug').textContent.includes('本地模拟'));
const ledger=()=>page.evaluate(k=>JSON.parse(localStorage.getItem(k)),key);
const started=s=>s.events.filter(e=>e.event==='prototype.model.started').length;
const running=s=>s.records.filter(r=>r.state==='running').length;
async function waitBalance(credits,busy){await page.waitForFunction(({key,credits,busy})=>{const s=JSON.parse(localStorage.getItem(key));return s.credits===credits&&s.records.filter(r=>r.state==='running').length===busy;},{key,credits,busy});}
async function seed(name){await page.selectOption('#scenario',name);await page.click('#load-scenario');await page.waitForFunction(name=>{const n=Number(document.querySelector('#available').textContent);return n===(name==='zero'?0:name==='last'?1:name==='limit'?6:3)&&document.querySelectorAll('.record[data-visible-state="running"]').length===0;},name);}
async function finish(){await page.click('#complete-all');await page.waitForFunction(k=>!JSON.parse(localStorage.getItem(k)).records.some(r=>r.state==='running'),key);}
async function callsEqual(n){await page.waitForFunction(({key,n})=>JSON.parse(localStorage.getItem(key)).events.filter(e=>e.event==='prototype.model.started').length===n,{key,n});}
const checks=[];
async function check(id,name,fn){try{await fn();checks.push({id,name,status:'PASS'});console.log(id+' PASS '+name);}catch(e){checks.push({id,name,status:'FAIL',error:e.message});console.log(id+' FAIL '+e.message);}}

await check('P01','成功前占用，保存成功后消耗',async()=>{await seed('new');await page.click('#generate');await waitBalance(3,1);assert.equal(await page.textContent('#available'),'2');assert.match(await page.textContent('#occupied'),/占用 1/);await finish();await waitBalance(2,0);assert.equal(started(await ledger()),1);assert.equal((await ledger()).records[0].state,'success');await page.waitForFunction(()=>document.querySelector('#result').textContent.includes('准备产品评审材料'));});
await check('P02','零额度阻止生成，仍可编辑和查看',async()=>{
 await seed('zero');assert(await page.isDisabled('#generate'));
 await page.locator('.task-check').first().check();
 await page.waitForFunction(k=>JSON.parse(localStorage.getItem(k)).tasks[0].isDone,key);
 assert(await page.locator('.task-hours').first().isDisabled());
 await page.locator('.task-hours').nth(1).fill('2');await page.locator('.task-hours').nth(1).dispatchEvent('change');
 await page.waitForFunction(k=>JSON.parse(localStorage.getItem(k)).tasks[1].time===2,key);
 await page.locator('[data-action="delete"]').first().click();
 await page.waitForFunction(k=>JSON.parse(localStorage.getItem(k)).tasks.length===1,key);
 await page.fill('#description','零额度仍可添加');await page.click('#task-form button');
 await page.waitForFunction(()=>document.querySelector('#tasks').textContent.includes('零额度仍可添加'));
 await page.click('[data-action="view"]');assert.match(await page.textContent('#result'),/完成项目需求方案/);
 await page.click('#refresh-records');await page.click('#remote-submit');
 assert.equal(started(await ledger()),0);assert.equal((await ledger()).credits,0);
});
await check('P03','模型明确失败释放占用，不消耗',async()=>{await seed('modelFail');await page.click('#generate');await waitBalance(3,1);await finish();await waitBalance(3,0);assert.equal(started(await ledger()),1);assert.equal((await ledger()).records[0].state,'failed');await page.waitForFunction(()=>document.querySelector('#notice').textContent==='生成失败，本次未消耗额度。');assert.match(await page.textContent('#records'),/生成失败，本次未消耗额度/);assert(!((await page.textContent('#product')).includes('模型明确失败')));});
await check('P04','保存明确失败释放占用，无成功结果',async()=>{await seed('saveFail');await page.click('#generate');await finish();await waitBalance(3,0);const s=await ledger();assert.equal(s.records[0].reason,'日程未能保存');assert.equal(s.records[0].result,undefined);});
await check('P05','两个页面争用最后一次，最多一次开始',async()=>{await seed('last');const other=await context.newPage();await other.goto(base);await other.waitForFunction(()=>document.querySelector('#debug').textContent.includes('本地模拟'));await Promise.all([page.click('#remote-submit'),other.click('#remote-submit')]);await callsEqual(1);await Promise.all([page.locator('#notice').waitFor({state:'visible'}),other.locator('#notice').waitFor({state:'visible'})]);assert.match((await page.textContent('#notice'))+(await other.textContent('#notice')),/可用额度正在使用/);const s=await ledger();assert.equal(s.records.length,1);assert.equal(running(s),1);assert.equal(s.credits-running(s),0);await other.close();await finish();await waitBalance(0,0);});
await check('P06','有6次额度时仅接受3个并发，不排队',async()=>{await seed('limit');for(let i=0;i<4;i++)await page.click('#remote-submit');await callsEqual(3);await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('已有 3 份'));let s=await ledger();assert.equal(running(s),3);assert.equal(s.credits,6);await finish();await waitBalance(3,0);s=await ledger();assert.equal(s.records.length,3);assert.equal(started(s),3);});
await check('P07','完成后释放名额，可手动新提交',async()=>{await seed('limit');for(let i=0;i<4;i++)await page.click('#remote-submit');await callsEqual(3);await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('已有 3 份'));await finish();await waitBalance(3,0);await page.waitForFunction(()=>document.querySelector('#notice').hidden);await page.click('#remote-submit');await callsEqual(4);assert.equal(running(await ledger()),1);await finish();await waitBalance(2,0);});
await check('P08','本页连续触发不创建重复请求',async()=>{await seed('new');await Promise.all([page.locator('#generate').dispatchEvent('click'),page.locator('#generate').dispatchEvent('click')]);await callsEqual(1);assert.equal((await ledger()).records.length,1);await finish();assert.equal((await ledger()).credits,2);});
await check('P09','响应丢失先查询原请求，不重复调用',async()=>{await seed('lost');await page.click('#generate');await page.waitForSelector('[data-visible-state="unknown"]');await finish();assert.equal((await ledger()).credits,2);assert(await page.isDisabled('#generate'));await page.screenshot({path:assets+'prototype-uncertain.png',fullPage:true});await page.click('[data-action="query"]');await page.waitForSelector('[data-visible-state="success"]');assert.equal(started(await ledger()),1);assert.match(await page.textContent('#result'),/完成项目需求方案/);assert.match(await page.textContent('#notice'),/查询未消耗额度/);assert(!((await page.textContent('#notice')).includes('消耗 1 次额度')));await page.screenshot({path:assets+'prototype-recovered.png',fullPage:true});});
await check('P10','查询失败仍待确认，不生成、不退款',async()=>{await seed('lost');await page.click('#generate');await finish();await page.check('#query-offline');await page.click('[data-action="query"]');assert.match(await page.textContent('#notice'),/暂时无法查询/);assert.equal(await page.locator('[data-visible-state="unknown"]').count(),1);assert.equal((await ledger()).credits,2);assert.equal(started(await ledger()),1);await page.uncheck('#query-offline');});
await check('P11','刷新保留待确认记录，恢复同一结果',async()=>{const id=(await ledger()).records[0].id;await page.reload();await page.waitForSelector('[data-visible-state="unknown"]');await page.click('[data-action="query"]');await page.waitForSelector('[data-visible-state="success"]');assert.equal((await ledger()).records[0].id,id);assert.equal(started(await ledger()),1);assert.equal((await ledger()).credits,2);assert.match(await page.textContent('#notice'),/查询未消耗额度/);assert(!((await page.textContent('#notice')).includes('消耗 1 次额度')));});
await check('P12','生成中编辑只影响后续输入',async()=>{await seed('new');await page.click('#generate');await page.fill('#description','提交后新增的任务');await page.click('#task-form button');await page.fill('#hours','4');await page.locator('#hours').dispatchEvent('change');await finish();const s=await ledger();assert.equal(s.tasks.length,3);assert.equal(s.hours,4);assert.equal(s.records[0].tasks.length,2);assert.equal(s.records[0].hours,8);assert(!s.records[0].result.tasks.some(t=>t.name==='提交后新增的任务'));assert.match(await page.textContent('#tasks'),/提交后新增的任务/);});
await check('P13','不同输入的混合请求各自结算，结果不串联',async()=>{
 await seed('new');await page.click('#remote-submit');await callsEqual(1);
 const firstId=(await ledger()).records[0].id;
 await page.fill('#description','[fail] 明确失败');await page.click('#task-form button');
 await page.waitForFunction(()=>document.querySelector('#tasks').textContent.includes('[fail] 明确失败'));
 await page.click('#remote-submit');await callsEqual(2);const failedId=(await ledger()).records[0].id;
 await page.locator('.task-row').filter({hasText:'[fail] 明确失败'}).locator('[data-action="delete"]').click();
 await page.fill('#description','第二份日程专属任务');await page.click('#task-form button');
 await page.waitForFunction(()=>document.querySelector('#tasks').textContent.includes('第二份日程专属任务'));
 await page.fill('#hours','4');await page.locator('#hours').dispatchEvent('change');
 await page.click('#remote-submit');await callsEqual(3);const secondId=(await ledger()).records[0].id;
 await finish();await waitBalance(1,0);const s=await ledger();
 const first=s.records.find(r=>r.id===firstId),second=s.records.find(r=>r.id===secondId),failed=s.records.find(r=>r.id===failedId);
 assert.equal(first.state,'success');assert.equal(second.state,'success');assert.equal(failed.state,'failed');
 assert.deepEqual(first.result.tasks.map(t=>t.name),['完成项目需求方案','准备产品评审材料']);
 assert.deepEqual(second.result.tasks.map(t=>t.name),['完成项目需求方案','准备产品评审材料','第二份日程专属任务']);
 assert.equal(first.hours,8);assert.equal(second.hours,4);
 assert.equal(first.result.tasks[0].steps[0].hours,1.33);assert.equal(second.result.tasks[0].steps[0].hours,.44);
 assert(failed.tasks.some(t=>t.description.includes('[fail]')));assert.equal(failed.result,undefined);
 assert.equal(started(s),3);assert.equal(running(s),0);
});
await check('P14','用户输入按文本展示，不执行HTML',async()=>{await seed('new');const text='<img src=x onerror="window.__prototypeXss=1">';await page.fill('#description',text);await page.click('#task-form button');await page.waitForFunction(()=>document.querySelector('#tasks').textContent.includes('<img src=x'));assert.equal(await page.evaluate(()=>window.__prototypeXss),undefined);await page.click('#generate');await finish();assert.equal(await page.locator('#result img').count(),0);assert.equal(await page.evaluate(()=>window.__prototypeXss),undefined);});
await check('P17','另一页面重置后清除旧待确认引用，可再次生成',async()=>{await seed('lost');await page.click('#generate');await page.waitForSelector('[data-visible-state="unknown"]');const other=await context.newPage();await other.goto(base);await other.selectOption('#scenario','new');await other.click('#load-scenario');await page.waitForFunction(()=>document.querySelector('#available').textContent==='3'&&document.querySelectorAll('.record').length===0);assert(await page.isEnabled('#generate'));assert.equal(await page.locator('[data-action="query"]').count(),0);await page.click('#generate');await callsEqual(1);assert.equal((await ledger()).records.length,1);await other.close();await finish();});
await check('P18','额度耗尽后仍可查询原请求，不再次消耗',async()=>{
 await seed('lost');await page.click('#generate');await page.waitForSelector('[data-visible-state="unknown"]');
 await page.click('#remote-submit');await page.click('#remote-submit');await callsEqual(3);await finish();await waitBalance(0,0);
 assert(await page.locator('[data-action="query"]').isEnabled());await page.click('[data-action="query"]');
 await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('查询未消耗额度'));
 assert.equal((await ledger()).credits,0);assert.equal(started(await ledger()),3);
 assert.match(await page.textContent('#result'),/完成项目需求方案/);assert(await page.isDisabled('#generate'));
});
await check('P15','桌面与移动端无横向溢出，标注可切换',async()=>{await seed('new');await page.click('#generate');await finish();await page.click('#remote-submit');await page.click('#annotation-toggle');assert.equal(await page.getAttribute('#annotation-toggle','aria-pressed'),'true');assert(await page.locator('.annotation-note').isVisible());await page.click('#annotation-toggle');await page.screenshot({path:assets+'prototype-desktop.png',fullPage:true});for(const width of [390,320]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),`overflow at ${width}`);const recordBox=await page.locator('#records-heading').boundingBox(),resultBox=await page.locator('#result-heading').boundingBox();assert(recordBox.y<resultBox.y,'mobile records must precede result');if(width===390)await page.screenshot({path:assets+'prototype-mobile.png',fullPage:true});}await page.setViewportSize({width:1440,height:1100});});
await check('P16','浏览器执行无未捕获脚本错误',async()=>{assert.deepEqual(errors,[]);});
const result={scope:'Local interactive prototype only. Not validation of the Wasp app, PostgreSQL, or real provider.',executedAt:new Date().toISOString(),timingFixture:'Browser Date.now held at run start; generation completes only when the demo completion control is used. Product default timing is unchanged.',browser:'Chromium '+browser.version(),viewport:{desktop:'1440×1100',mobile:['390×900','320×900']},checks,passed:checks.filter(c=>c.status==='PASS').length,total:checks.length,consoleErrors:errors};
await fs.writeFile(out,JSON.stringify(result,null,2)+'\n');
await browser.close();
console.log(JSON.stringify({passed:result.passed,total:result.total}));
if(result.passed!==result.total)process.exitCode=1;
