(() => {
  'use strict';

  const key = 'task-planner-quota-prototype-v1';
  const $ = (id) => document.getElementById(id);
  const scenes = {
    normal: { credits: 3, outcome: 'success', description: '从 3 次额度开始，添加或调整任务，再点击“生成日程”。' },
    fail: { credits: 3, outcome: 'failure', description: '这次模拟模型明确失败。失败后保留额度与上次日程，再次点击可体验重试成功。' },
    last: { credits: 1, outcome: 'success', description: '只剩最后 1 次额度。成功后查看额度用完时的反馈与操作入口。' },
    zero: { credits: 0, outcome: 'success', description: '当前没有额度。生成入口会提前拦住，你仍可编辑任务和查看已有日程。' },
    unknown: { credits: 3, outcome: 'unknown', description: '模拟生成响应丢失。先核对刚才的结果，避免把重发请求当成恢复操作。' },
  };

  const freshState = () => ({
    version: 1, credits: 3, scene: 'normal', nextOutcome: 'success', status: 'idle', hours: 4,
    tasks: [
      { id: 'sample-one', name: '整理面试资料', duration: 1, done: false },
      { id: 'sample-two', name: '准备项目演示', duration: 1.5, done: false },
    ],
    result: null, hiddenResult: null, pending: null, draftChanged: false, theme: 'light',
  });

  let storageAvailable = true;
  let state;
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) || 'null');
    state = stored?.version === 1 && Array.isArray(stored.tasks) && Number.isInteger(stored.credits) && stored.credits >= 0 && scenes[stored.scene]
      ? stored : freshState();
    sessionStorage.setItem(key, JSON.stringify(state));
  } catch {
    storageAvailable = false;
    state = freshState();
  }
  // A check is only a local read. Reloading during it returns to the unconfirmed state.
  if (state.status === 'checking') state.status = 'unknown';
  let generationTimer;
  let checkTimer;
  let themeTransition;
  let themeRevision = 0;
  let themeIntent = state.theme === 'dark' ? 'dark' : 'light';

  const persist = () => {
    if (!storageAvailable) return;
    try { sessionStorage.setItem(key, JSON.stringify(state)); }
    catch { storageAvailable = false; }
  };
  const newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const working = () => state.status === 'generating' || state.status === 'checking';
  const unresolved = () => state.status === 'unknown' || state.status === 'checking';
  const pendingTasks = () => state.tasks.filter((task) => !task.done);
  const validHours = () => Number.isFinite(state.hours) && state.hours >= 1 && state.hours <= 24 && Number.isInteger(state.hours * 2);
  const validTaskHours = () => pendingTasks().every((task) => Number.isFinite(task.duration) && task.duration >= .5 && task.duration <= 24 && Number.isInteger(task.duration * 2));
  const clock = (minutes) => `${minutes >= 1440 ? '次日 ' : ''}${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const duration = (minutes) => {
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return `${hours ? `${hours} 小时` : ''}${hours && remainder ? ' ' : ''}${remainder || !hours ? `${remainder} 分钟` : ''}`;
  };

  function markDraftChanged() {
    if (state.result || state.pending) state.draftChanged = true;
    if (state.pending) state.pending.draftChanged = true;
    if (state.hiddenResult) state.hiddenResult.draftChanged = true;
    if (state.status === 'success') state.status = 'idle';
  }

  function renderTasks() {
    const list = $('tasks-list');
    list.replaceChildren();
    for (const task of state.tasks) {
      const row = $('task-row-template').content.firstElementChild.cloneNode(true);
      row.dataset.taskId = task.id;
      row.classList.toggle('is-complete', task.done);
      row.querySelector('.task-name').textContent = task.name;
      const checkbox = row.querySelector('.task-checkbox');
      checkbox.checked = task.done;
      checkbox.setAttribute('aria-label', `标记“${task.name}”完成`);
      checkbox.addEventListener('change', () => {
        task.done = checkbox.checked;
        row.classList.toggle('is-complete', task.done);
        row.querySelector('.task-duration input').disabled = task.done;
        markDraftChanged();
        persist();
        render();
      });
      const time = row.querySelector('.task-duration input');
      time.value = task.duration;
      time.disabled = task.done;
      time.setAttribute('aria-label', `“${task.name}”预计时长，小时`);
      row.querySelector('.task-duration .sr-only').textContent = `${task.name}预计时长`;
      time.addEventListener('input', () => {
        task.duration = Number(time.value);
        time.setAttribute('aria-invalid', String(!time.validity.valid || !time.value));
        markDraftChanged();
        persist();
        render();
      });
      const remove = row.querySelector('.delete-task');
      remove.setAttribute('aria-label', `删除任务：${task.name}`);
      remove.title = `删除任务：${task.name}`;
      remove.addEventListener('click', () => {
        state.tasks = state.tasks.filter((candidate) => candidate.id !== task.id);
        markDraftChanged();
        persist();
        renderTasks();
        render();
      });
      list.append(row);
    }
  }

  function showFeedback(tone, title, body, symbol = 'info') {
    $('feedback').hidden = false;
    $('feedback').dataset.tone = tone;
    $('feedback-title').textContent = title;
    $('feedback-body').textContent = body;
    $('feedback-symbol').setAttribute('href', `#i-${symbol}`);
  }

  function renderTheme() {
    document.documentElement.dataset.theme = state.theme;
    const label = state.theme === 'dark' ? '切换浅色模式' : '切换深色模式';
    $('theme-toggle').setAttribute('aria-label', label);
    $('theme-toggle').title = label;
    document.querySelector('meta[name="theme-color"]').content = state.theme === 'dark' ? '#101923' : '#f5f7fa';
  }

  function toggleTheme(event) {
    const root = document.documentElement;
    const nextTheme = themeIntent === 'dark' ? 'light' : 'dark';
    themeIntent = nextTheme;
    const revision = ++themeRevision;
    const update = () => {
      // An interrupted transition must not apply an older click after a newer one.
      if (revision !== themeRevision) return;
      state.theme = nextTheme;
      persist();
      renderTheme();
    };
    themeTransition?.skipTransition();
    themeTransition = null;
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof document.startViewTransition !== 'function' || reduceMotion || event.detail === 0) {
      delete root.dataset.themeTransition;
      update();
      return;
    }

    const { left, top, width, height } = $('theme-toggle').getBoundingClientRect();
    const x = left + width / 2;
    const y = top + height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    root.dataset.themeTransition = 'active';
    let transition;
    try {
      transition = document.startViewTransition(update);
    } catch {
      delete root.dataset.themeTransition;
      update();
      return;
    }
    themeTransition = transition;
    transition.ready.then(() => {
      if (revision !== themeRevision) return;
      // The reference uses a full-page circle reveal, so it gets a deliberate 500ms.
      const reveal = root.animate({
        clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`],
      }, {
        duration: 500,
        easing: getComputedStyle(root).getPropertyValue('--ease-in-out').trim(),
        pseudoElement: '::view-transition-new(root)',
      });
      reveal.finished.catch(() => {});
    }).catch(() => {
      // A skipped visual transition is expected during rapid input or tab changes.
      transition.skipTransition();
    });
    transition.finished.catch(update).finally(() => {
      if (themeTransition !== transition) return;
      themeTransition = null;
      delete root.dataset.themeTransition;
    });
  }

  function render() {
    renderTheme();
    const active = pendingTasks();
    const busy = working();
    const unknown = unresolved();
    const invalid = !validHours() || !validTaskHours();
    const hasCredits = state.credits > 0;

    $('credit-balance').textContent = unknown ? '待核对' : String(state.credits);
    $('credit-unit').hidden = unknown;
    $('task-count').textContent = `${active.length} 项待安排`;
    $('tasks-empty').hidden = state.tasks.length > 0;
    $('workload').textContent = validTaskHours()
      ? `待办预计用时 ${Number(active.reduce((sum, task) => sum + task.duration, 0).toFixed(1))} 小时`
      : '请将任务时长设为 0.5–24 小时，以 0.5 小时递增。';
    $('hours-error').hidden = validHours();
    $('available-hours').setAttribute('aria-invalid', String(!validHours()));
    $('task-submit').disabled = !$('task-input').value.trim();

    for (const button of document.querySelectorAll('[data-scene]')) {
      button.setAttribute('aria-pressed', String(button.dataset.scene === state.scene));
      button.disabled = busy;
    }
    $('scenario-description').textContent = scenes[state.scene].description;
    $('generate-button').disabled = busy || unknown || !hasCredits || !active.length || invalid;
    $('generate-button').classList.toggle('is-working', state.status === 'generating');
    $('generate-button').setAttribute('aria-busy', String(state.status === 'generating'));
    $('generate-spinner').hidden = state.status !== 'generating';
    $('generate-icon').hidden = state.status === 'generating';
    $('generate-label').textContent = state.status === 'generating' ? '生成中…'
      : unknown ? '等待核对结果'
      : !hasCredits ? '额度已用完'
      : !active.length ? '请先添加待办'
      : invalid ? '请检查时长'
      : state.status === 'failure' ? '重试生成'
      : state.result ? '重新生成日程' : '生成日程';

    $('check-result-button').hidden = !unknown;
    $('check-result-button').disabled = state.status === 'checking';
    $('check-result-button').querySelector('span').textContent = state.status === 'checking' ? '正在核对…' : '核对结果';
    $('feedback').hidden = true;
    if (state.status === 'generating') {
      showFeedback('info', '正在生成日程', '已预留 1 次额度。成功后消耗，明确失败会恢复可用次数。', 'clock');
      $('generate-hint').textContent = '本次处理中，暂未确认扣费。';
    } else if (unknown) {
      showFeedback('warning', state.status === 'checking' ? '正在核对结果' : '结果尚未确认', '连接中断不代表生成失败。请先核对刚才的结果，避免重复生成。', 'alert');
      $('generate-hint').textContent = '核对只读取结果，不会再次生成或重复扣费。';
    } else if (state.status === 'failure') {
      showFeedback('error', '生成失败，本次未消耗额度', '任务和上一次日程已保留。你可以直接重试生成。', 'alert');
      $('generate-hint').textContent = `当前仍可用 ${state.credits} 次额度。`;
    } else if (state.status === 'success') {
      showFeedback('success', '日程已生成，本次消耗 1 次', hasCredits ? `当前还可用 ${state.credits} 次。调整任务后，可以重新生成。` : '额度已用完，你仍可编辑任务、查看这份日程。', 'check');
      $('generate-hint').textContent = hasCredits ? `当前可用 ${state.credits} 次。` : '继续查看日程和编辑任务，不消耗额度。';
    } else if (!hasCredits) {
      showFeedback('warning', '额度已用完', '你仍可编辑任务、查看已经保存的日程。当前不能发起新的生成。', 'info');
      $('generate-hint').textContent = '继续查看日程和编辑任务，不消耗额度。';
    } else {
      $('generate-hint').textContent = !active.length ? '请先添加至少一项未完成的待办。'
        : invalid ? '修正时长后即可生成，不会提前消耗额度。'
        : `当前可用 ${state.credits} 次，生成成功后还可用 ${state.credits - 1} 次。`;
    }
    renderResult();
    if (!storageAvailable) {
      document.querySelector('.prototype-note > span:last-child').textContent = '演示数据仅在内存中保留，刷新会重置。';
      document.querySelector('.saved-note span').textContent = '本浏览器未允许会话保存，刷新会清空演示数据。';
    }
  }

  function renderResult() {
    const result = state.result;
    $('schedule-empty').hidden = Boolean(result);
    $('schedule-result').hidden = !result;
    $('result-pending').hidden = state.status !== 'generating' || !result;
    $('result-badge').dataset.ready = String(Boolean(result));
    $('result-badge').textContent = result ? state.draftChanged || state.status === 'failure' || unresolved() ? '已保留' : '已生成' : '尚未生成';
    $('result-heading').textContent = result && (state.draftChanged || state.status === 'failure' || unresolved()) ? '上一次日程' : '本次日程';
    if (!result) {
      $('result-description').textContent = state.status === 'generating' ? '正在为这些任务安排时间…' : unresolved() ? '先核对刚才的结果，确认后再展示。' : '你的任务会在这里变成一份日程。';
      return;
    }
    const savedAt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(result.createdAt));
    $('result-description').textContent = `${savedAt} 生成。${state.draftChanged ? '任务已调整，当前保留上一份日程。' : '这份日程已为你保留。'}`;
    $('schedule-range').textContent = `${clock(540)} — ${clock(540 + result.minutes)}`;
    $('schedule-total').textContent = `${duration(result.minutes)}，${result.tasks.length} 项任务`;
    const list = $('schedule-list');
    list.replaceChildren();
    for (const task of result.tasks) {
      const item = document.createElement('article');
      item.className = 'plan-item';
      item.classList.toggle('is-complete', task.done);
      const time = document.createElement('p');
      time.className = 'plan-time';
      time.textContent = `${clock(task.start)} — ${clock(task.start + task.minutes)}`;
      const card = document.createElement('div');
      card.className = 'plan-card';
      const row = document.createElement('div');
      row.className = 'plan-title-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'plan-checkbox';
      checkbox.checked = Boolean(task.done);
      checkbox.setAttribute('aria-label', `标记日程“${task.name}”完成`);
      checkbox.addEventListener('change', () => {
        task.done = checkbox.checked;
        item.classList.toggle('is-complete', task.done);
        persist();
      });
      const heading = document.createElement('h3');
      heading.textContent = task.name;
      const timing = document.createElement('span');
      timing.className = 'plan-duration';
      timing.textContent = duration(task.minutes);
      row.append(checkbox, heading, timing);
      const steps = document.createElement('div');
      steps.className = 'plan-steps';
      const preparation = Math.floor(task.minutes * .2);
      const reflection = Math.floor(task.minutes * .2);
      for (const [name, minutes] of [['准备', preparation], ['执行', task.minutes - preparation - reflection], ['复盘', reflection]]) {
        const step = document.createElement('span');
        step.textContent = `${name} ${minutes} 分钟`;
        steps.append(step);
      }
      card.append(row, steps);
      item.append(time, card);
      list.append(item);
    }
  }

  function makeSchedule(pending) {
    const minutes = Math.round(pending.hours * 60);
    const weight = pending.tasks.reduce((sum, task) => sum + task.duration, 0);
    let assigned = 0;
    const tasks = pending.tasks.map((task, index) => {
      const count = index === pending.tasks.length - 1 ? minutes - assigned : Math.floor(minutes * task.duration / weight);
      const scheduled = { name: task.name, start: 540 + assigned, minutes: count, done: false };
      assigned += count;
      return scheduled;
    });
    return { id: pending.id, createdAt: Date.now(), minutes, tasks, draftChanged: pending.draftChanged };
  }

  function settleGeneration(id) {
    const pending = state.pending;
    if (!pending || pending.id !== id) return;
    state.pending = null;
    state.nextOutcome = 'success';
    if (pending.outcome === 'failure') {
      state.status = 'failure';
    } else {
      state.credits -= 1;
      const result = makeSchedule(pending);
      if (pending.outcome === 'unknown') {
        state.hiddenResult = result;
        state.status = 'unknown';
      } else {
        state.result = result;
        state.hiddenResult = null;
        state.status = 'success';
        state.draftChanged = pending.draftChanged;
      }
    }
    persist();
    render();
  }

  function generate() {
    if (working() || unresolved() || state.credits < 1 || !pendingTasks().length || !validHours() || !validTaskHours()) return;
    const id = newId();
    state.pending = { id, outcome: state.nextOutcome, hours: state.hours, tasks: pendingTasks().map((task) => ({ name: task.name, duration: task.duration })), finishAt: Date.now() + 1400, draftChanged: false };
    state.status = 'generating';
    persist();
    render();
    generationTimer = setTimeout(() => settleGeneration(id), 1400);
  }

  $('task-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('task-input').value.trim();
    if (!name) return;
    state.tasks.push({ id: newId(), name: name.slice(0, 100), duration: 1, done: false });
    $('task-input').value = '';
    markDraftChanged();
    persist();
    renderTasks();
    render();
    $('task-input').focus();
  });
  $('task-input').addEventListener('input', () => { $('task-submit').disabled = !$('task-input').value.trim(); });
  $('available-hours').addEventListener('input', () => {
    state.hours = Number($('available-hours').value);
    markDraftChanged();
    persist();
    render();
  });
  $('generate-button').addEventListener('click', generate);
  $('check-result-button').addEventListener('click', () => {
    if (state.status !== 'unknown') return;
    state.status = 'checking';
    persist();
    render();
    checkTimer = setTimeout(() => {
      if (state.status !== 'checking') return;
      if (state.hiddenResult) {
        state.draftChanged = state.hiddenResult.draftChanged;
        state.result = state.hiddenResult;
        state.hiddenResult = null;
        state.status = 'success';
      } else {
        state.status = 'unknown';
      }
      persist();
      render();
    }, 600);
  });
  for (const button of document.querySelectorAll('[data-scene]')) {
    button.addEventListener('click', () => {
      if (working()) return;
      clearTimeout(generationTimer);
      clearTimeout(checkTimer);
      const scene = button.dataset.scene;
      state.scene = scene;
      state.credits = scenes[scene].credits;
      state.nextOutcome = scenes[scene].outcome;
      state.status = 'idle';
      state.pending = null;
      state.hiddenResult = null;
      state.draftChanged = Boolean(state.result);
      persist();
      render();
    });
  }
  $('reset-demo').addEventListener('click', () => {
    clearTimeout(generationTimer);
    clearTimeout(checkTimer);
    const theme = state.theme;
    state = freshState();
    state.theme = theme;
    $('task-input').value = '';
    $('available-hours').value = state.hours;
    persist();
    renderTasks();
    render();
  });
  $('theme-toggle').addEventListener('click', toggleTheme);

  $('today').textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());
  $('available-hours').value = state.hours;
  renderTasks();
  render();
  if (state.pending && state.status === 'generating') {
    const { id, finishAt } = state.pending;
    generationTimer = setTimeout(() => settleGeneration(id), Math.max(0, finishAt - Date.now()));
  }
})();
