// Offline product prototype. Server facts and visible snapshots are deliberately
// separate: editing a task must never reveal an unreceived network response.
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
let scene, server, view, tasks, calls, saved, running, unknown, reviewed, epoch = 0;
let loadError, historyError, lastConfirmed, currentSuccess, otherSnapshot, forcedRefreshFailure;
const defaultTasks = () => ['整理面试材料', '完成项目复盘'];
function message(text, tone = 'neutral') { $('status').textContent = text; $('status').dataset.tone = tone; }
function syncMessage(text) { $('syncStatus').textContent = text; $('syncStatus').dataset.tone = 'warning'; }
function validHours() { const h = Number($('hours').value); return Number.isFinite(h) && h >= 1 && h <= 24 && Number.isInteger(h * 2); }
function schedule(items, hours) { return items.map(t => `<div class="schedule"><b>${esc(t)}</b><span class="muted">准备 → 执行 → 复盘 · 约 ${(hours / items.length).toFixed(1)} 小时</span></div>`).join(''); }
function render() {
  $('credits').textContent = loadError || view.credits === null ? '—' : view.credits;
  $('calls').textContent = calls; $('saved').textContent = saved;
  $('tasks').innerHTML = tasks.map((t, i) => `<div class="taskrow"><div class="task"><span class="dot">○</span>${esc(t)}</div><button class="secondary" data-remove="${i}" aria-label="删除${esc(t)}" ${running ? 'disabled' : ''}>删除</button></div>`).join('');
  const reason = running ? '生成进行中，成功保存后才扣费。'
    : loadError || view.credits === null ? '额度读取失败，请刷新后再生成。'
    : unknown ? '本次结果尚待核对。请先刷新，核对后再主动发起新生成。'
    : view.credits <= 0 ? '额度已用完，可查看已有日程或继续编辑任务。'
    : !tasks.length ? '请先添加至少一条待办事项。'
    : !validHours() ? '请填写 1–24 小时，并以 0.5 小时为步长。' : '';
  $('eligibility').textContent = reason;
  $('generate').disabled = !!reason;
  $('generate').innerHTML = running ? '<span class="spin">◌</span> 正在生成…' : '生成日程 · 成功后扣 1 额度';
  for (const id of ['hours', 'taskInput', 'add', 'refresh']) $(id).disabled = running;
  $('hoursHint').textContent = validHours() ? '可填写 1–24 小时，以 0.5 小时为步长。' : '时长无效，请填写 1–24 小时，并以 0.5 小时为步长。';
  $('confirmReview').hidden = !(unknown && reviewed);
  $('confirmReview').disabled = loadError || view.credits <= 0;
  $('completeOther').hidden = !server.inFlight;
  $('history').innerHTML = (historyError ? '<p role="status">最新历史尚未读取成功，请刷新重试；以下如有内容为上次读取记录。</p>' : '') +
    (view.history.length ? view.history.slice(0, 20).map(p => `<details><summary>${esc(p.time)} · ${esc(p.id)}</summary>${schedule(p.tasks, p.hours)}</details>`).join('') : '<p class="empty">暂无已读取的日程记录</p>');
  $('resultTitle').textContent = lastConfirmed && !currentSuccess ? '上次已保存日程' : '本次日程';
  $('resultbadge').textContent = lastConfirmed ? (currentSuccess ? '本次已保存' : '历史结果 · 非本次') : '';
  $('result').className = lastConfirmed ? '' : 'empty';
  $('result').innerHTML = lastConfirmed ? schedule(lastConfirmed.tasks, lastConfirmed.hours) : '尚未确认本次生成成功。已保存记录可在下方核查。';
}
function sync() { view = { credits: server.credits, history: [...server.history] }; loadError = false; historyError = false; }
function commit(items, hours) {
  if (server.credits < 1) throw new Error('Prototype invariant: no credit to commit');
  server.credits--; saved++;
  const p = { id: 'PLAN-' + String(saved).padStart(3, '0'), time: new Date().toLocaleString('zh-CN'), tasks: [...items], hours };
  server.history.unshift(p); return p;
}
function reset(next) {
  epoch++; scene = next; tasks = defaultTasks(); calls = saved = 0; running = unknown = reviewed = false;
  loadError = next === 'loadfail'; historyError = false; lastConfirmed = null; currentSuccess = false;
  forcedRefreshFailure = next === 'refreshfail';
  server = { credits: next === 'empty' ? 0 : ['success', 'unknown', 'refreshfail'].includes(next) ? 3 : 1, history: [], inFlight: next === 'busy' };
  view = { credits: server.credits, history: [] };
  if (next === 'fail') tasks.push('需要调整的任务 [fail]');
  if (next === 'busy') { calls = 1; otherSnapshot = { tasks: ['另一页面提交的任务'], hours: 4 }; }
  if (next === 'stale') {
    server.credits = 0;
    server.history = [{ id: 'PREVIOUS-001', time: '另一页面刚刚保存', tasks: defaultTasks(), hours: 8 }];
  }
  $('hours').value = 8; $('taskInput').value = ''; message(''); syncMessage('');
  document.querySelectorAll('[data-scene]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scene === next)));
  $('scenarioHint').textContent = next === 'busy' ? '刷新只读取状态，不会完成请求。可点击“模拟另一页请求完成”，再刷新核查。'
    : next === 'fail' ? '与仓库 mock 一致：任何任务含 [fail] 就会失败。需删除该任务后再重试。'
    : next === 'unknown' ? '服务端已保存但响应丢失。编辑输入不会提前揭示未收到的余额或历史。'
    : next === 'notreceived' ? '请求未送达服务端。客户端仍只能提示未知；刷新并核对后可主动发起新请求。'
    : next === 'stale' ? '页面仍显示1额度，实际已被另一页用完。点击生成观察服务端拒绝。'
    : '点击生成，观察额度、反馈与历史日程。';
  render();
}
$('scenarios').addEventListener('click', e => { const b = e.target.closest('[data-scene]'); if (b) reset(b.dataset.scene); });
$('tasks').addEventListener('click', e => { const b = e.target.closest('[data-remove]'); if (b && !running) { tasks.splice(Number(b.dataset.remove), 1); render(); } });
function add() { const t = $('taskInput').value.trim(); if (t && !running) { tasks.push(t); $('taskInput').value = ''; render(); } }
$('add').onclick = add;
$('taskInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) add(); });
$('hours').oninput = render;
$('generate').onclick = async () => {
  if (running || $('generate').disabled) return;
  currentSuccess = false; reviewed = false; syncMessage('');
  if (server.inFlight) { message('该账号正在生成日程，本次未发起新的生成。请等待完成后刷新查看。', 'warning'); render(); return; }
  if (server.credits < 1) { sync(); message('额度已用完，本次未调用模型。可查看已有日程或继续编辑任务。', 'warning'); render(); return; }
  running = true; const token = epoch, items = [...tasks], hours = Number($('hours').value);
  if (scene !== 'notreceived') calls++;
  message('正在生成，成功保存后消耗 1 额度。'); render();
  await new Promise(resolve => setTimeout(resolve, 700)); if (token !== epoch) return;
  running = false;
  if (scene === 'notreceived') {
    unknown = true; message('暂时无法确认结果，请先刷新额度与已有日程；重新生成成功会再次扣费。', 'warning'); render(); return;
  }
  if (items.some(t => t.includes('[fail]'))) {
    message('生成失败，本次未扣费。请调整任务后重试。', 'error'); sync(); render(); return;
  }
  if (scene === 'savefail') {
    message('日程保存失败，本次未扣费，请稍后重试。', 'error'); scene = 'success'; sync(); render(); return;
  }
  const p = commit(items, hours);
  if (scene === 'unknown') {
    unknown = true; message('暂时无法确认结果，请先刷新额度与已有日程；重新生成成功会再次扣费。', 'warning'); render(); return;
  }
  lastConfirmed = p; currentSuccess = true;
  message('生成成功，已消耗 1 额度，日程已保存。', 'success');
  if (forcedRefreshFailure) {
    forcedRefreshFailure = false; loadError = historyError = true;
    syncMessage('最新额度与历史暂未刷新，请重试。上方生成成功的结论不变。');
  } else sync();
  render();
};
$('refresh').onclick = () => {
  if (running) return;
  sync(); syncMessage('');
  if (server.inFlight) message('该账号仍在生成中，当前记录可能尚未更新。请等待完成后再刷新。', 'warning');
  else if (unknown) { reviewed = true; syncMessage('已读取当前额度与已有日程，请核对时间和内容。记录暂未出现不等于之前请求失败；不确定时请继续等待并刷新。'); }
  else syncMessage('额度与已有日程已刷新。');
  render();
};
$('confirmReview').onclick = () => {
  if (!reviewed || loadError || view.credits <= 0) return;
  unknown = false; scene = 'success'; reviewed = false;
  message('你可以主动生成一份新日程；成功后会再消耗 1 额度。此前请求不因此被认定为失败。', 'warning'); render();
};
$('completeOther').onclick = () => {
  if (!server.inFlight) return;
  commit(otherSnapshot.tasks, otherSnapshot.hours); server.inFlight = false;
  $('scenarioHint').textContent = '另一页请求已完成。当前页面仍是旧快照，请点击刷新核查。'; render();
};
reset('success');
