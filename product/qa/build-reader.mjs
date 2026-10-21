import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = [
  ['submission', '交付概览', '../SUBMISSION.md'], ['prd', '需求与流程', 'PRD.md'],
  ['delivery', '开发拆解', 'DELIVERY.md'], ['acceptance', '验收案例', 'ACCEPTANCE.md'],
  ['review', '审查与证据', 'REVIEW.md'],
];
const flow = `<div class="flow"><div><b>01 · 用户发起</b><p>读取额度 → 编辑任务 → 点击生成</p></div><div><b>02 · 服务端准入</b><p>认证 / 参数 → 账号处理权 → 最新任务与余额</p><small>无资格：明确拒绝，不调用模型</small></div><div><b>03 · 生成与提交</b><p>模型返回 → 条件扣1额度与保存结果的同一事务</p><small>明确失败或确认回滚：不扣费</small></div><div><b>04 · 告知与核查</b><p>成功：展示新日程；网络未知：先刷新核查，再主动决定新生成</p><small>重叠请求不排队；刷新不等于原请求已结束</small></div></div>`;
const links = { '../SUBMISSION.md':'#submission', 'PRD.md':'#prd', 'DELIVERY.md':'#delivery', 'ACCEPTANCE.md':'#acceptance', 'REVIEW.md':'#review', 'product/阅读入口.html':'#submission' };
let body = '';
for (const [id, title, relative] of entries) {
  let html = marked.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
  // SUBMISSION is one directory above this derived reader; rebase its links.
  if (id === 'submission') html = html.replaceAll('href="product/', 'href="');
  html = html.replace(/href="([^"]+)"/g, (m, url) => links[url] ? `href="${links[url]}"` : m);
  html = html.replace(/<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/g, flow);
  html = html.replaceAll('<table>', '<div class="table-wrap"><table>').replaceAll('</table>', '</table></div>');
  body += `<section id="${id}" aria-label="${title}">${html}</section>`;
}
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>李晗亮｜日程生成额度体验改进</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f5f8;color:#1d3041;font:15px/1.85 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}a{color:#126c61;text-underline-offset:3px}a:focus-visible{outline:3px solid #bf8e21;outline-offset:4px}aside{position:fixed;inset:0 auto 0 0;width:230px;background:#163141;color:#e6f1f5;padding:38px 24px}aside b{font-size:19px}aside p{color:#b6cbd5;font-size:13px}nav{display:grid;gap:9px;margin:26px 0}nav a{color:#e4edf3;text-decoration:none;padding:8px 12px;border-radius:7px}nav a:hover{background:#284b59}.cta{display:block;background:#b4e4d6;color:#163c34;padding:12px;border-radius:8px;text-align:center;text-decoration:none;font-weight:700}main{margin-left:230px;padding:42px 44px;max-width:1430px}.banner{padding:30px 34px;background:#e4f1eb;border:1px solid #cbe1d5;border-radius:14px;margin-bottom:26px}.banner small{letter-spacing:2px;color:#286c5c}.banner h1{font-size:31px;line-height:1.45;margin:10px 0}.banner p{margin:5px 0}.badge{display:inline-block;padding:5px 11px;border-radius:5px;background:#fff;font-size:12px;margin:12px 7px 0 0}section{background:white;border:1px solid #dce4e9;padding:32px 36px;margin-bottom:25px;border-radius:14px;scroll-margin-top:20px}section h1{font-size:25px;margin:0 0 16px;line-height:1.5}h2{font-size:20px;margin:29px 0 13px;border-top:1px solid #e7edf1;padding-top:22px}h3{font-size:17px;margin-top:25px}p{margin:10px 0}li{margin:7px 0}code{font-family:ui-monospace,Consolas,monospace;background:#edf2f6;border-radius:4px;padding:2px 4px;font-size:13px;overflow-wrap:anywhere}pre{background:#eff3f6;padding:16px;overflow:auto}.table-wrap{overflow:auto;margin:15px 0}table{border-collapse:collapse;width:100%;font-size:13px;min-width:650px}th,td{border:1px solid #dce4e9;padding:11px 12px;text-align:left;vertical-align:top}th{background:#ecf3f1;color:#20574d}td p{margin:0}.flow{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0}.flow>div{background:#edf5f1;border:1px solid #c9dfd4;padding:18px;border-radius:10px}.flow small{color:#5c7369}.foot{color:#667d8b;font-size:12px}section img{max-width:100%}@media(max-width:900px){aside{position:static;width:auto;padding:22px}nav{display:flex;flex-wrap:wrap;gap:3px;margin:12px 0}nav a{padding:7px 9px}.cta{max-width:240px}main{margin:0;padding:18px}section{padding:22px 18px}.banner{padding:22px}.banner h1{font-size:26px}.flow{grid-template-columns:1fr}}@media print{aside,.cta{display:none}main{margin:0;padding:0}section{border:0;break-before:page;padding:10px}.banner{background:none}.table-wrap{overflow:visible}table{min-width:0;font-size:10px}th,td{padding:5px}.flow>div{break-inside:avoid}}
</style></head><body><aside><b>日程生成额度改进</b><p>产品方向 · AI 产品经理<br>李晗亮｜181****2618</p><nav>${entries.map(([id,title]) => `<a href="#${id}">${title}</a>`).join('')}</nav><a class="cta" href="prototype.html">打开可点击原型 →</a><p>v1.1 · 二次审查修订<br>可离线阅读，无需安装依赖</p></aside><main><div class="banner"><small>PRODUCT CASE / 2026</small><h1>成功才扣费，失败有解释，<br>结果未知时先核查。</h1><p>生成前准入，同账号重叠请求立即拒绝，成功保存时扣除1额度。</p><span class="badge">10种原型场景</span><span class="badge">13组系统验收案例</span><span class="badge">42项原型检查通过</span><p class="foot">本次是产品方案交付。原型检查不等于真实服务端或数据库验收。</p></div>${body}<p class="foot">本页由交付中的Markdown生成；修改正文后请运行product/qa中的build:reader重新生成。正文与实际验证边界以源文档为准。</p></main></body></html>`;
fs.writeFileSync(path.join(root, '阅读入口.html'), html);
console.log('Built product/阅读入口.html from 5 source documents.');
