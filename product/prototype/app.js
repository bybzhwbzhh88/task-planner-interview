/* global QuotaModel */
(function () {
  "use strict";

  const { QuotaStore, attemptGeneration, simulateConcurrentRequests, wait } =
    QuotaModel;

  const $ = (id) => document.getElementById(id);
  const cloneTasks = (tasks) => tasks.map((task) => ({ ...task }));

  const DEFAULT_TASKS = cloneTasks(QuotaModel.DEFAULT_TASKS);
  const FAIL_TASK = {
    id: "task-fail",
    description: "演练失败任务 [fail]",
    time: 0.5,
    done: false,
  };

  const state = {
    store: new QuotaStore(3),
    tasks: cloneTasks(DEFAULT_TASKS),
    hours: 8,
    busy: false,
    logs: [],
    schedule: null,
    status: null,
    concurrency: null,
    lastResult: null,
    runId: 0,
  };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => {
      const map = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      };
      return map[char];
    });
  }

  function formatHours(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return Number.isInteger(number) ? String(number) : number.toFixed(1);
  }

  function timestamp() {
    return new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }

  function addLog(event) {
    state.logs.push({ ...event, time: timestamp() });
    if (state.logs.length > 200) state.logs.shift();
    renderLogs();
  }

  function clearLogs() {
    state.logs = [];
    renderLogs();
  }

  function setStatus(kind, title, body, action) {
    state.status = { kind, title, body, action };
  }

  function clearStatus() {
    state.status = null;
  }

  /* ---------------- render ---------------- */

  function renderCredits() {
    const value = Math.max(0, state.store.credits);
    $("credits-value").textContent = String(value);
    const pill = $("credits-pill");
    pill.classList.toggle("is-zero", value === 0);
    pill.classList.toggle("is-busy", state.busy);
  }

  function renderTasks() {
    const list = $("task-list");
    const count = $("task-count");
    list.innerHTML = "";
    count.textContent = state.tasks.length
      ? `${state.tasks.length} 条任务`
      : "暂无任务";

    if (state.tasks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML =
        "<strong>还没有待办</strong><span>先添加一条任务，再生成日程。</span>";
      list.appendChild(empty);
      return;
    }

    state.tasks.forEach((task) => {
      const row = document.createElement("div");
      row.className = "task-item";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(task.done);
      checkbox.disabled = state.busy;
      checkbox.className = "task-check";
      checkbox.setAttribute("aria-label", `标记“${task.description}”已完成`);
      checkbox.addEventListener("change", () => {
        task.done = checkbox.checked;
        renderTasks();
      });

      const main = document.createElement("div");
      main.className = "task-main";

      const text = document.createElement("span");
      text.className = "task-text" + (task.done ? " is-done" : "");
      text.textContent = task.description;

      const meta = document.createElement("span");
      meta.className = "task-meta";
      meta.textContent = `${formatHours(task.time)} 小时`;

      if (task.description.includes("[fail]")) {
        const badge = document.createElement("span");
        badge.className = "fail-badge";
        badge.textContent = "模拟失败";
        meta.appendChild(badge);
      }

      main.append(text, meta);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon-button";
      remove.textContent = "移除";
      remove.disabled = state.busy;
      remove.addEventListener("click", () => {
        state.tasks = state.tasks.filter((item) => item.id !== task.id);
        renderAll();
      });

      row.append(checkbox, main, remove);
      list.appendChild(row);
    });
  }

  function renderGenerateState() {
    const button = $("generate-button");
    const hint = $("generate-hint");
    const hoursValid =
      Number.isFinite(state.hours) && state.hours >= 1 && state.hours <= 24;

    button.disabled =
      state.busy || state.tasks.length === 0 || state.store.credits <= 0;
    button.textContent = state.busy ? "生成中…" : "生成日程";

    hint.classList.remove("is-warning");
    if (state.busy) {
      hint.textContent = "正在生成，请稍候…";
    } else if (state.tasks.length === 0) {
      hint.textContent = "请先添加至少一个任务。";
    } else if (state.store.credits <= 0) {
      hint.textContent = "额度已用完，本次不会发起生成，也不会扣额度。";
      hint.classList.add("is-warning");
    } else if (!hoursValid) {
      hint.textContent = "可用时长需在 1–24 小时之间。";
      hint.classList.add("is-warning");
    } else {
      hint.textContent = "每次成功生成扣 1 个额度；模型失败不扣。";
    }
  }

  function renderStatus() {
    const banner = $("status-banner");
    if (!state.status) {
      banner.hidden = true;
      return;
    }

    banner.hidden = false;
    banner.className = `status-banner status-${state.status.kind}`;
    $("status-title").textContent = state.status.title;
    $("status-body").textContent = state.status.body;
    $("status-action").textContent = state.status.action || "";

    const icon = $("status-icon");
    icon.textContent = {
      success: "✓",
      warning: "!",
      error: "×",
      info: "i",
    }[state.status.kind] || "i";
  }

  function renderSchedule() {
    const content = $("schedule-content");
    const meta = $("schedule-meta");
    content.innerHTML = "";

    if (!state.schedule) {
      meta.textContent = "";
      content.innerHTML =
        '<div class="empty-state"><strong>还没有日程</strong><span>点击“生成日程”后，这里会展示本次结果。</span></div>';
      return;
    }

    const schedule = state.schedule;
    const remaining =
      state.concurrency &&
      state.lastResult &&
      Number.isFinite(state.lastResult.remainingAtReserve)
        ? state.lastResult.remainingAtReserve
        : state.lastResult && Number.isFinite(state.lastResult.remaining)
          ? state.lastResult.remaining
          : state.store.credits;
    const remainingLabel = state.concurrency
      ? "该请求预扣后剩余"
      : "剩余";
    meta.textContent = `本次扣 1 个额度 · ${remainingLabel} ${remaining} 个`;

    if (!schedule.tasks || schedule.tasks.length === 0) {
      content.innerHTML =
        '<div class="empty-state"><strong>没有可展示的任务</strong><span>请调整任务后重试。</span></div>';
      return;
    }

    schedule.tasks.forEach((task, index) => {
      const card = document.createElement("article");
      card.className = "schedule-card";

      const header = document.createElement("div");
      header.className = "schedule-card-header";

      const titleWrap = document.createElement("div");
      titleWrap.className = "schedule-title-wrap";
      const order = document.createElement("span");
      order.className = "schedule-order";
      order.textContent = String(index + 1).padStart(2, "0");
      const title = document.createElement("h3");
      title.textContent = task.name;
      titleWrap.append(order, title);

      const priority = document.createElement("span");
      priority.className = "priority priority-" + (task.priority || "medium");
      priority.textContent =
        { high: "高优先级", medium: "中优先级", low: "低优先级" }[
          task.priority
        ] || "中优先级";

      header.append(titleWrap, priority);
      card.appendChild(header);

      const items = document.createElement("ul");
      items.className = "schedule-items";
      const taskItems = (schedule.taskItems || []).filter(
        (item) => item.taskName === task.name,
      );
      if (taskItems.length === 0) {
        const empty = document.createElement("li");
        empty.className = "muted";
        empty.textContent = "没有子任务明细。";
        items.appendChild(empty);
      } else {
        taskItems.forEach((item) => {
          const li = document.createElement("li");
          const desc = document.createElement("span");
          desc.textContent = item.description;
          const time = document.createElement("span");
          time.className = "schedule-item-time";
          time.textContent = `${formatHours(item.time)} 小时`;
          li.append(desc, time);
          items.appendChild(li);
        });
      }
      card.appendChild(items);
      content.appendChild(card);
    });
  }

  function renderConcurrency() {
    const box = $("concurrency-results");
    box.innerHTML = "";

    if (!state.concurrency) {
      box.innerHTML = '<p class="muted">运行场景 4 或 5 查看。</p>';
      return;
    }

    const { results, finalCredits, credits, count } = state.concurrency;
    const success = results.filter((item) => item.status === "success").length;
    const insufficient = results.filter(
      (item) => item.status === "insufficient",
    ).length;

    const summary = document.createElement("div");
    summary.className = "concurrency-summary";
    summary.innerHTML = `<strong>${success} 成功 / ${insufficient} 不足</strong><span>${count} 个请求 · ${credits} 额度起 · 最终 ${finalCredits}</span>`;
    box.appendChild(summary);

    results.forEach((item) => {
      const row = document.createElement("div");
      row.className = "concurrency-row";

      const id = document.createElement("span");
      id.className = "concurrency-id";
      id.textContent = item.requestId;

      const status = document.createElement("span");
      status.className = "concurrency-status status-" + item.status;
      status.textContent = {
        success: "成功",
        insufficient: "额度不足",
        failed: "失败",
      }[item.status];

      const detail = document.createElement("span");
      detail.className = "concurrency-detail";
      if (item.status === "success") {
        detail.textContent = `预扣后余额 ${item.remainingAtReserve}`;
      } else if (item.status === "insufficient") {
        detail.textContent = "未调用模型";
      } else {
        detail.textContent = "已退款";
      }

      row.append(id, status, detail);
      box.appendChild(row);
    });
  }

  function logLabel(event) {
    const labels = {
      "request.received": ["请求到达", "event-request"],
      "credit.reserved": ["预扣成功", "event-credit"],
      "credit.insufficient": ["额度不足", "event-warning"],
      "credit.refunded": ["已退款", "event-refund"],
      "mock-ai.started": ["模型调用开始", "event-started"],
      "mock-ai.succeeded": ["模型成功", "event-success"],
      "mock-ai.failed": ["模型失败", "event-error"],
    };
    return labels[event.type] || [event.type, "event-request"];
  }

  function logDetail(event) {
    if (event.type === "request.received") return event.requestId || "";
    if (event.type === "credit.reserved") {
      return `${event.requestId || ""} · 剩余 ${event.remaining}`;
    }
    if (event.type === "credit.insufficient") {
      return `${event.requestId || ""} · 未调用模型 · 剩余 ${event.remaining}`;
    }
    if (event.type === "credit.refunded") {
      return `${event.requestId || ""} · 剩余 ${event.remaining}`;
    }
    if (event.type === "mock-ai.started" || event.type === "mock-ai.succeeded") {
      return `${event.callId || ""} · ${event.requestId || ""}`;
    }
    if (event.type === "mock-ai.failed") {
      return `${event.callId || ""} · ${event.message || "模型失败"}`;
    }
    return "";
  }

  function renderLogs() {
    const box = $("log-list");
    if (!box) return;
    box.innerHTML = "";

    if (state.logs.length === 0) {
      box.innerHTML = '<p class="muted">还没有请求。</p>';
      return;
    }

    state.logs.forEach((event) => {
      const row = document.createElement("div");
      row.className = "log-row";

      const time = document.createElement("span");
      time.className = "log-time";
      time.textContent = event.time;

      const [label, className] = logLabel(event);
      const badge = document.createElement("span");
      badge.className = "log-badge " + className;
      badge.textContent = label;

      const detail = document.createElement("span");
      detail.className = "log-detail";
      detail.textContent = logDetail(event);

      row.append(time, badge, detail);
      box.appendChild(row);
    });

    box.scrollTop = box.scrollHeight;
  }

  function renderAll() {
    renderCredits();
    renderTasks();
    renderGenerateState();
    renderStatus();
    renderSchedule();
    renderConcurrency();
    renderLogs();
  }

  /* ---------------- actions ---------------- */

  function buildSchedule(tasks, hours) {
    const perTask = hours / Math.max(tasks.length, 1);
    return {
      tasks: tasks.map((task, index) => ({
        name: task.description,
        priority: index === 0 ? "high" : index === 1 ? "medium" : "low",
      })),
      taskItems: tasks.flatMap((task) =>
        ["准备", "执行", "复盘"].map((step) => ({
          description: `${step}：${task.description}`,
          taskName: task.description,
          time: Number((perTask / 3).toFixed(2)),
        })),
      ),
    };
  }

  function makeProvider() {
    return async ({ tasks, hours }) => {
      await wait(850);
      if (tasks.some((task) => task.description.includes("[fail]"))) {
        throw new Error("Mock provider explicitly rejected the request");
      }
      return buildSchedule(tasks, hours);
    };
  }

  function validateBeforeGenerate() {
    if (state.tasks.length === 0) {
      setStatus(
        "warning",
        "请先添加任务",
        "当前没有待办任务，所以不会生成日程，也不会扣额度。",
        "在“添加待办”输入框里添加一条任务后再试。",
      );
      return false;
    }

    if (!Number.isFinite(state.hours) || state.hours < 1 || state.hours > 24) {
      setStatus(
        "warning",
        "时长不在可用范围",
        "今天可用的工作时长需要在 1–24 小时之间。",
        "修正时长后再生成；本次不会扣额度。",
      );
      return false;
    }

    if (state.store.credits <= 0) {
      setStatus(
        "warning",
        "额度不足",
        "本次没有生成日程，也没有扣除额度。当前剩余 0 个。",
        "请联系管理员补充额度，或使用其他账号后再试。",
      );
      return false;
    }

    return true;
  }

  async function runSingle(options) {
    const { force = false } = options || {};
    if (state.busy) return;

    if (!force && !validateBeforeGenerate()) {
      renderAll();
      return;
    }

    state.busy = true;
    state.schedule = null;
    state.lastResult = null;
    state.concurrency = null;
    state.status = null;
    state.logs = [];
    state.runId += 1;
    renderAll();

    try {
      const result = await attemptGeneration(state.store, {
        tasks: state.tasks,
        hours: state.hours,
        provider: makeProvider(),
        onEvent: addLog,
        requestId: "req-" + state.runId,
      });

      if (result.status === "success") {
        state.schedule = result.schedule;
        state.lastResult = result;
        setStatus(
          "success",
          "日程已生成",
          `本次扣除 1 个额度，剩余 ${state.store.credits} 个。`,
          "可以调整任务后再次生成；每次成功生成都会再扣 1 个额度。",
        );
      } else if (result.status === "insufficient") {
        setStatus(
          "warning",
          "额度不足",
          "本次没有生成日程，也没有扣除额度。当前剩余 0 个。",
          "请联系管理员补充额度，或使用其他账号后再试。",
        );
      } else {
        setStatus(
          "error",
          "生成失败",
          "模型没有返回可用日程，本次未扣除额度。",
          "请删除含 [fail] 的任务，或稍后重试。",
        );
      }
    } catch (error) {
      setStatus(
        "error",
        "出现未预期错误",
        "本次结果未知，请刷新页面确认额度后再试。",
        "不要连续点击；若余额异常，请联系管理员。",
      );
      console.error(error);
    } finally {
      state.busy = false;
      renderAll();
    }
  }

  async function runConcurrency(credits, count) {
    if (state.busy) return;

    state.busy = true;
    state.schedule = null;
    state.lastResult = null;
    state.concurrency = null;
    state.status = null;
    state.logs = [];
    state.runId += 1;
    renderAll();

    try {
      const outcome = await simulateConcurrentRequests({
        credits,
        requestCount: count,
        tasks: state.tasks,
        hours: state.hours,
        provider: makeProvider(),
        onEvent: addLog,
        staggerMs: 70,
      });

      state.store = outcome.store;
      const success = outcome.results.filter(
        (item) => item.status === "success",
      );
      const insufficient = outcome.results.filter(
        (item) => item.status === "insufficient",
      );

      state.concurrency = {
        credits,
        count,
        results: outcome.results,
        finalCredits: outcome.credits,
      };

      const firstSuccess = success[0];
      if (firstSuccess) {
        state.schedule = firstSuccess.schedule;
        state.lastResult = firstSuccess;
      }

      setStatus(
        "info",
        "并发演示完成",
        `${count} 个请求中，${success.length} 个成功，${insufficient.length} 个额度不足；最终余额 ${outcome.credits}。`,
        "额度不足的请求没有发起模型调用；成功请求各扣 1 个额度。",
      );
    } catch (error) {
      setStatus(
        "error",
        "并发演示出错",
        "本次结果未知，请重置后重试。",
        "如果反复出现，请查看控制台错误。",
      );
      console.error(error);
    } finally {
      state.busy = false;
      renderAll();
    }
  }

  function reset(options) {
    const { credits = 3, tasks = DEFAULT_TASKS, hours = 8 } = options || {};
    state.store = new QuotaStore(credits);
    state.tasks = cloneTasks(tasks);
    state.hours = hours;
    state.busy = false;
    state.logs = [];
    state.schedule = null;
    state.status = null;
    state.concurrency = null;
    state.lastResult = null;
    state.runId = 0;
    $("hours-input").value = String(hours);
    renderAll();
  }

  async function runScenario(name) {
    if (state.busy) return;

    if (name === "success") {
      reset({ credits: 3, tasks: DEFAULT_TASKS });
      await runSingle();
      return;
    }

    if (name === "insufficient") {
      reset({ credits: 0, tasks: DEFAULT_TASKS });
      await runSingle({ force: true });
      return;
    }

    if (name === "failure") {
      reset({ credits: 3, tasks: DEFAULT_TASKS.concat([FAIL_TASK]) });
      await runSingle();
      return;
    }

    if (name === "concurrency1") {
      reset({ credits: 1, tasks: DEFAULT_TASKS });
      await runConcurrency(1, 3);
      return;
    }

    if (name === "concurrency3") {
      reset({ credits: 3, tasks: DEFAULT_TASKS });
      await runConcurrency(3, 5);
      return;
    }

    if (name === "reset") {
      reset();
    }
  }

  /* ---------------- events ---------------- */

  function addTaskFromInput() {
    if (state.busy) return;
    const input = $("task-input");
    const value = input.value.trim();
    if (!value) {
      input.focus();
      return;
    }

    state.tasks.push({
      id: "task-" + Date.now(),
      description: value.slice(0, 60),
      time: 1,
      done: false,
    });
    input.value = "";
    clearStatus();
    renderAll();
    input.focus();
  }

  function addFailTask() {
    if (state.busy) return;
    state.tasks.push({
      ...FAIL_TASK,
      id: "task-fail-" + Date.now(),
    });
    clearStatus();
    renderAll();
  }

  function bindEvents() {
    $("generate-button").addEventListener("click", () => {
      if (!validateBeforeGenerate()) {
        renderAll();
        return;
      }
      runSingle();
    });

    $("add-task").addEventListener("click", addTaskFromInput);
    $("add-fail-task").addEventListener("click", addFailTask);
    $("task-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") addTaskFromInput();
    });

    $("hours-input").addEventListener("input", (event) => {
      state.hours = Number(event.target.value);
      renderGenerateState();
    });

    document.querySelectorAll("[data-scenario]").forEach((button) => {
      button.addEventListener("click", () => {
        const name = button.getAttribute("data-scenario");
        if (name) runScenario(name);
      });
    });

    $("reset-button").addEventListener("click", () => reset());
  }

  function maybeAutoRun() {
    const params = new URLSearchParams(window.location.search);
    const scenario = params.get("scenario");
    if (!scenario) return;
    if (params.get("auto") === "0") return;
    window.setTimeout(() => {
      runScenario(scenario).catch((error) => console.error(error));
    }, 120);
  }

  function init() {
    bindEvents();
    reset();
    maybeAutoRun();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
