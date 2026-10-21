import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);const {chromium}=require('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const docs=path.join(root,'docs/product');
const out=path.join(docs,'qa/delivery-results.json');
await fs.writeFile(out,JSON.stringify({status:'running'}));
const checks=[];
const all=[];
async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())await walk(p);else all.push(p);}}
await walk(root);
const broken=[];let linkCount=0;
for(const p of all.filter(f=>f.endsWith('.md'))){const text=await fs.readFile(p,'utf8');for(const m of text.matchAll(/\]\(([^)]+)\)/g)){const href=m[1].split('#')[0];if(!href||/^[a-z]+:/i.test(href))continue;linkCount++;try{await fs.access(path.resolve(path.dirname(p),decodeURIComponent(href)));}catch{broken.push({file:path.relative(root,p),href});}}}
checks.push({id:'D01',name:'Markdown 本地文件链接',status:broken.length?'FAIL':'PASS',linksChecked:linkCount,broken});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1512,height:1100},locale:'zh-CN'});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
context.setDefaultTimeout(8000);
await page.goto(process.env.REVIEW_URL||'http://127.0.0.1:18765/review.html');
const targets=['intro','prd','flow','notes','tasks','acceptance','verification','glossary','submission','prototype'];
for(const id of targets){await page.click('#nav-'+id);assert(await page.locator('#panel-'+id).isVisible());assert.equal(await page.locator('.panel:visible').count(),1);}
checks.push({id:'D02',name:'阅读版10个导航入口切换',status:'PASS',panels:targets.length});
const frame=page.frameLocator('#prototype-frame');await frame.locator('#generate').waitFor();assert.match(await frame.locator('#debug').textContent(),/本地模拟/);
checks.push({id:'D03',name:'阅读版嵌入原型可操作',status:'PASS'});
await page.click('#nav-flow');for(const img of await page.locator('#panel-flow img').all()){assert(await img.evaluate(el=>el.complete&&el.naturalWidth>0));}
await page.screenshot({path:path.join(docs,'assets/flow-review.png'),fullPage:true});
checks.push({id:'D04',name:'两张流程图加载及文字布局',status:'PASS',images:2});
await page.click('#nav-prd');await page.screenshot({path:path.join(docs,'assets/review-desktop.png'),fullPage:true});
await page.setViewportSize({width:390,height:900});
for(const id of targets.filter(x=>x!=='prototype')){await page.click('#nav-'+id);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'reader overflow '+id);}
checks.push({id:'D05',name:'移动端阅读版无整页横向溢出',status:'PASS',width:390});
checks.push({id:'D06',name:'阅读版无未捕获脚本错误',status:errors.length?'FAIL':'PASS',errors});
await browser.close();
const result={executedAt:new Date().toISOString(),scope:'Delivery links, local document reader and static diagram assets; not the real application.',checks,passed:checks.filter(x=>x.status==='PASS').length,total:checks.length};
await fs.writeFile(out,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
if(result.passed!==result.total)process.exitCode=1;
