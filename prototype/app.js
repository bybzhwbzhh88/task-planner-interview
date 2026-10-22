const CONFIG = Object.freeze({
  initialCredits: 3,
  providerDelayMs: 650,
  maxEvents: 60,
});

const SCENARIO_ORDER = ["P1", "P2", "P3", "P4"];

const SCENARIOS = {
  P1: {
    name: "成功扣 1",
    initialCredits: 3,
    failInjected: false,
    expected: {
      credits: 2,
      providerCalls: 1,
      successes: 1,
      failures: 0,
      refusals: 0,
      refunds: 0,
      reservations: 1,
    },
    expectedLabel: "余额 2 · 调用 1 · 成功 1 · 回执 success · 日程显示",
    async run() {
      await simulateGenerate({
        attemptId: "SIM-P1-A1",
        lane: "A",
        source: "主页面",
        primary: true,
      });
    },
    uiCheck() {
      return (
        getReceiptKind() === "success" &&
        !els.resultSection.hidden &&
        getServerAttemptCount() === 1
      );
    },
    actualLabel() {
      return `余额 ${state.credits} · 调用 ${state.providerCalls} · 成功 ${state.successes} · 回执 ${getReceiptKind()} · 日程${
        els.resultSection.hidden ? "缺失" : "显示"
      }`;
    },
  },
  P2: {
    name: "零额度拦截",
    initialCredits: 0,
    failInjected: false,
    precheckBlocked: true,
    expected: {
      credits: 0,
      providerCalls: 0,
      successes: 0,
      failures: 0,
      refusals: 1,
      refunds: 0,
      reservations: 0,
    },
    expectedLabel: "余额 0 · 调用 0 · 拒绝 1 · 按钮停用 · 零额度警告显示",
    async run() {
      await sleep(180);
      await simulateGenerate({
        attemptId: "SIM-P2-API1",
        lane: "API",
        source: "绕过页面的直连请求",
        primary: false,
        note: "服务端以条件更新为准；余额为 0 时影响 0 行，不调用模型。",
      });
    },
    uiCheck() {
      return (
        els.generateBtn.disabled &&
        !els.zeroNotice.hidden &&
        getReceiptKind() === "none"
      );
    },
    actualLabel() {
      return `余额 ${state.credits} · 调用 ${state.providerCalls} · 拒绝 ${state.refusals} · 按钮${
        els.generateBtn.disabled ? "停用" : "可点"
      } · 零额度警告${els.zeroNotice.hidden ? "缺失" : "显示"}`;
    },
  },
  P3: {
    name: "模型失败返还",
    initialCredits: 2,
    failInjected: true,
    expected: {
      credits: 2,
      providerCalls: 1,
      successes: 0,
      failures: 1,
      refusals: 0,
      refunds: 1,
      reservations: 1,
    },
    expectedLabel: "余额 2 · 调用 1 · 失败 1 · 返还 1 · 回执 failure",
    async run() {
      await simulateGenerate({
        attemptId: "SIM-P3-A1",
        lane: "A",
        source: "主页面",
        primary: true,
      });
    },
    uiCheck() {
      return (
        getReceiptKind() === "failure" &&
        Boolean(els.statusRegion.querySelector('[data-action="retry"]'))
      );
    },
    actualLabel() {
      return `余额 ${state.credits} · 调用 ${state.providerCalls} · 失败 ${state.failures} · 返还 ${state.refunds} · 回执 ${getReceiptKind()}`;
    },
  },
  P4: {
    name: "并发只放行 1 个",
    initialCredits: 1,
    failInjected: false,
    expected: {
      credits: 0,
      providerCalls: 1,
      successes: 1,
      failures: 0,
      refusals: 1,
      refunds: 0,
      reservations: 1,
    },
    expectedLabel: "余额 0 · 调用 1 · 成功 1 · 拒绝 1 · 轨道 2 · 回执 success",
    async run() {
      const first = simulateGenerate({
        attemptId: "SIM-P4-A1",
        lane: "A",
        source: "标签页 A",
        primary: true,
      });
      const second = simulateGenerate({
        attemptId: "SIM-P4-B1",
        lane: "B",
        source: "标签页 B · 同一 tick 提交",
        primary: false,
        note: "两个请求都先受理；条件预占只有一个成功，另一个影响 0 行。",
      });
      await Promise.all([first, second]);
    },
    uiCheck() {
      return (
        getReceiptKind() === "success" &&
        getServerAttemptCount() === 2 &&
        state.credits === 0
      );
    },
    actualLabel() {
      return `余额 ${state.credits} · 调用 ${state.providerCalls} · 成功 ${state.successes} · 拒绝 ${state.refusals} · 轨道 ${getServerAttemptCount()} · 回执 ${getReceiptKind()}`;
    },
  },
};

let state = createState();
let activeRun = null;
let manualAttemptSequence = 0;

const els = {
  balanceChip: document.getElementById("balanceChip"),
  balanceValue: document.getElementById("balanceValue"),
  costHint: document.getElementById("costHint"),
  hintCredits: document.getElementById("hintCredits"),
  lastCreditHint: document.getElementById("lastCreditHint"),
  zeroNotice: document.getElementById("zeroNotice"),
  generateBtn: document.getElementById("generateBtn"),
  generateLabel: document.getElementById("generateLabel"),
  buttonSpinner: document.querySelector(".button-spinner"),
  statusRegion: document.getElementById("statusRegion"),
  resultSection: document.getElementById("resultSection"),
  resultTitle: document.getElementById("resultTitle"),
  resultBadge: document.querySelector(".result-badge"),
  schedule: document.getElementById("schedule"),
  hours: document.getElementById("hours"),
  task2Row: document.getElementById("task2Row"),
  task2Name: document.getElementById("task2Name"),
  task2Meta: document.getElementById("task2Meta"),
  failChip: document.getElementById("failChip"),
  failToggle: document.getElementById("failToggle"),
  scenarioButtons: Array.from(document.querySelectorAll("[data-scenario]")),
  runAll: document.getElementById("runAll"),
  resetDemo: document.getElementById("resetDemo"),
  labRunStatus: document.getElementById("labRunStatus"),
  invariants: document.getElementById("invariants"),
  reconciliation: document.getElementById("reconciliation"),
  timeline: document.getElementById("timeline"),
  eventLog: document.getElementById("eventLog"),
  logCount: document.getElementById("logCount"),
  scenarioResults: document.getElementById("scenarioResults"),
};

wireEvents();
resetDemo("initial");

/* ---------------------------------- setup --------------------------------- */

function wireEvents() {
  els.generateBtn.addEventListener("click", () => startManualGeneration());
  els.runAll.addEventListener("click", runAllScenarios);
  els.resetDemo.addEventListener("click", () => resetDemo("button"));

  for (const button of els.scenarioButtons) {
    button.addEventListener("click", () => startSingleScenario(button.dataset.scenario));
  }

  els.failToggle.addEventListener("change", () => {
    if (activeRun) {
      els.failToggle.checked = state.failInjected;
      return;
    }
    state.failInjected = els.failToggle.checked;
    renderTaskDisplay();
    renderLabRunStatus(
      state.failInjected
        ? "已注入 [fail]：下一次模型调用会失败"
        : "已移除 [fail] 注入",
    );
  });

  els.statusRegion.addEventListener("click", (event) => {
    const retryButton = event.target.closest('[data-action="retry"]');
    if (retryButton) {
      startManualGeneration({ isRetry: true });
    }
  });

  for (const checkbox of document.querySelectorAll(".task-check")) {
    checkbox.addEventListener("change", () => {
      checkbox.closest(".task-row")?.classList.toggle("is-done", checkbox.checked);
    });
  }
}

function createState({
  initialCredits = CONFIG.initialCredits,
  failInjected = false,
  results = new Map(),
  precheckBlocked = false,
} = {}) {
  return {
    initialCredits,
    credits: initialCredits,
    successes: 0,
    failures: 0,
    refusals: 0,
    reservations: 0,
    providerCalls: 0,
    refunds: 0,
    attempts: [],
    events: [],
    results,
    scenarioId: null,
    running: false,
    primaryPending: false,
    failInjected,
    precheckBlocked,
    runStartedAt: performance.now(),
    lastSchedule: null,
    lastScheduleIsPrevious: false,
  };
}

function resetDemo(reason) {
  if (activeRun) {
    return;
  }

  state = createState();
  activeRun = null;
  els.statusRegion.innerHTML = "";
  els.hours.value = "8";
  resetTaskCheckmarks();
  renderAll();

  if (reason !== "initial") {
    renderLabRunStatus("演示已重置 · 可运行任一场景");
  }
}

function resetTaskCheckmarks() {
  for (const checkbox of document.querySelectorAll(".task-check")) {
    checkbox.checked = false;
    checkbox.closest(".task-row")?.classList.remove("is-done");
  }
}

/* ------------------------------- scenario flow ----------------------------- */

async function startSingleScenario(id) {
  if (activeRun || !SCENARIOS[id]) {
    return;
  }

  activeRun = id;
  try {
    await runScenarioInternal(id, { preserveResults: false });
  } catch (error) {
    console.error(error);
    renderLabRunStatus(`运行异常：${error.message}`);
  } finally {
    activeRun = null;
    renderAll();
  }
}

async function runAllScenarios() {
  if (activeRun) {
    return;
  }

  activeRun = "ALL";
  state.results = new Map();
  renderScenarioResults();

  try {
    for (const id of SCENARIO_ORDER) {
      await runScenarioInternal(id, { preserveResults: true });
      await sleep(420);
    }

    const passed = SCENARIO_ORDER.filter(
      (id) => state.results.get(id)?.status === "pass",
    ).length;
    renderLabRunStatus(`全部场景完成 · ${passed}/4 通过`);
  } catch (error) {
    console.error(error);
    renderLabRunStatus(`全部场景运行异常：${error.message}`);
  } finally {
    activeRun = null;
    renderAll();
  }
}

async function runScenarioInternal(id, { preserveResults }) {
  const scenario = SCENARIOS[id];
  const inheritedResults =
    preserveResults && state.results ? state.results : new Map();

  state = createState({
    initialCredits: scenario.initialCredits,
    failInjected: scenario.failInjected,
    results: inheritedResults,
    precheckBlocked: Boolean(scenario.precheckBlocked),
  });
  state.scenarioId = id;
  state.running = true;

  els.statusRegion.innerHTML = "";
  els.hours.value = "8";
  resetTaskCheckmarks();
  renderAll();
  renderLabRunStatus(`运行 ${id} · ${scenario.name}`);

  await sleep(240);

  try {
    await scenario.run();
    await sleep(180);

    const result = evaluateScenario(id);
    state.results.set(id, result);
    renderScenarioResults();
    renderLabRunStatus(
      `${id} ${result.status === "pass" ? "通过" : "未通过"} · ${scenario.name}`,
    );
  } catch (error) {
    console.error(error);

    const pendingAttempt = state.attempts.find((attempt) => attempt.primary);
    state.primaryPending = false;
    if (pendingAttempt) {
      renderUnknownReceipt(pendingAttempt.id);
      pendingAttempt.status = "unknown";
    }

    state.results.set(id, {
      id,
      name: scenario.name,
      expectedLabel: scenario.expectedLabel,
      actualLabel: `运行异常：${error.message}`,
      status: "fail",
    });
    renderScenarioResults();
    renderLabRunStatus(`${id} 运行异常`);
  } finally {
    state.running = false;
    renderAll();
  }
}

async function startManualGeneration({ isRetry = false } = {}) {
  if (activeRun || state.primaryPending) {
    return;
  }
  if (state.credits <= 0) {
    return;
  }

  activeRun = "MANUAL";
  state.scenarioId = null;
  state.precheckBlocked = false;
  state.events = [];
  state.attempts = [];
  state.runStartedAt = performance.now();

  manualAttemptSequence += 1;
  const sequence = String(manualAttemptSequence).padStart(2, "0");
  const attemptId = isRetry ? `SIM-RETRY-${sequence}` : `SIM-GEN-${sequence}`;

  els.statusRegion.innerHTML = "";
  renderEventLog();
  renderTimeline();
  renderInvariants();
  updateInteractionState();
  renderLabRunStatus(isRetry ? "手动重试：请求处理中" : "手动运行：请求处理中");

  try {
    await simulateGenerate({
      attemptId,
      lane: "A",
      source: isRetry ? "失败回执 · 重试" : "主页面",
      primary: true,
    });
    renderLabRunStatus("手动运行已结算 · 验收结果表保留");
  } catch (error) {
    console.error(error);
    state.primaryPending = false;
    renderUnknownReceipt(attemptId);
    renderProductState();
    renderLabRunStatus("手动运行异常 · 额度状态待确认");
  } finally {
    activeRun = null;
    state.primaryPending = false;
    renderAll();
  }
}

/* ------------------------------ simulation core ---------------------------- */

async function simulateGenerate({
  attemptId,
  lane = "A",
  source = "主页面",
  primary = false,
  note = "",
}) {
  const attempt = {
    id: attemptId,
    lane,
    source,
    primary,
    note,
    status: "pending",
    providerCalled: false,
    steps: [{ label: "请求受理", state: "neutral" }],
  };

  state.attempts.push(attempt);
  emit("quota.attempt.started", attempt, `来源：${source}`);
  renderTimeline();

  if (primary) {
    state.primaryPending = true;
    state.lastScheduleIsPrevious = Boolean(state.lastSchedule);
    renderPendingStatus();
    renderProductState();
  }

  // 让同一 tick 内先后发起的请求都先"到达服务端"，再竞争同一条条件更新。
  await Promise.resolve();

  const balanceBeforeReserve = state.credits;

  if (balanceBeforeReserve <= 0) {
    state.refusals += 1;
    attempt.status = "rejected";
    attempt.steps.push({
      label: `预占被拒（余额 ${balanceBeforeReserve}）`,
      state: "fail",
    });
    attempt.steps.push({ label: "未调用模型", state: "neutral" });
    emit(
      "quota.rejected",
      attempt,
      `余额 ${balanceBeforeReserve}；条件更新影响 0 行`,
    );
    emit("quota.settled", attempt, "insufficient_credits；净扣 0");
    renderTimeline();

    if (primary) {
      state.primaryPending = false;
      renderInsufficientReceipt(attemptId);
      renderProductState();
    }

    renderInvariants();
    return { status: "insufficient_credits", attemptId };
  }

  state.credits = balanceBeforeReserve - 1;
  state.reservations += 1;
  attempt.steps.push({
    label: `预占 ${balanceBeforeReserve} → ${state.credits}`,
    state: "ok",
  });
  emit(
    "quota.reserved",
    attempt,
    `余额 ${balanceBeforeReserve} → ${state.credits}`,
  );
  renderTimeline();

  const shouldFail = state.failInjected;
  const callId = `mock_${String(state.providerCalls + 1).padStart(2, "0")}`;

  attempt.providerCalled = true;
  state.providerCalls += 1;
  attempt.steps.push({ label: "模型调用中", state: "pending" });
  emit("mock-ai.started", attempt, `callId=${callId}`);
  renderTimeline();

  const providerStartedAt = performance.now();
  await sleep(CONFIG.providerDelayMs);
  const latency = Math.round(performance.now() - providerStartedAt);

  if (shouldFail) {
    state.failures += 1;
    const balanceBeforeRefund = state.credits;
    state.credits += 1;
    state.refunds += 1;

    attempt.status = "refunded";
    updatePendingStep(attempt, `模型失败 · ${latency}ms`, "fail");
    attempt.steps.push({
      label: `返还 1（${balanceBeforeRefund} → ${state.credits}）`,
      state: "ok",
    });

    emit("mock-ai.failed", attempt, `callId=${callId}；耗时 ${latency}ms`);
    emit(
      "quota.refunded",
      attempt,
      `余额 ${balanceBeforeRefund} → ${state.credits}`,
    );
    emit("quota.settled", attempt, "provider_failed；净扣 0");

    if (primary) {
      state.primaryPending = false;
      state.lastScheduleIsPrevious = Boolean(state.lastSchedule);
      renderFailureReceipt(attemptId);
      renderProductState();
    }

    renderTimeline();
    renderInvariants();
    return { status: "provider_failed", attemptId };
  }

  state.successes += 1;
  attempt.status = "success";
  updatePendingStep(attempt, `模型成功 · ${latency}ms`, "ok");
  attempt.steps.push({ label: "核销成功", state: "ok" });

  emit("mock-ai.succeeded", attempt, `callId=${callId}；耗时 ${latency}ms`);
  const schedule = buildSchedule();
  emit("plan.saved", attempt, "PlanResult 已写入");
  state.lastSchedule = schedule;
  state.lastScheduleIsPrevious = false;
  emit("quota.settled", attempt, `success；余额 ${state.credits}`);

  if (primary) {
    state.primaryPending = false;
    renderSuccessReceipt(attemptId);
    renderProductState();
  }

  renderTimeline();
  renderInvariants();
  return { status: "success", attemptId };
}

function updatePendingStep(attempt, label, stepState) {
  const step = attempt.steps.find(
    (item) => item.label === "模型调用中" && item.state === "pending",
  );
  if (step) {
    step.label = label;
    step.state = stepState;
  }
}

/* --------------------------------- events --------------------------------- */

function emit(type, attempt, detail = "") {
  state.events.push({
    type,
    attemptId: attempt?.id ?? "—",
    detail,
    at: Math.max(0, Math.round(performance.now() - state.runStartedAt)),
  });

  if (state.events.length > CONFIG.maxEvents) {
    state.events.shift();
  }

  renderEventLog();
  renderInvariants();
}

function renderEventLog() {
  els.logCount.textContent = `${state.events.length} 条`;

  if (state.events.length === 0) {
    els.eventLog.innerHTML =
      '<p class="empty-state">请求事件会出现在这里。</p>';
    return;
  }

  els.eventLog.innerHTML = state.events
    .map(
      (event) => `
        <div class="log-line ${eventClass(event.type)}" data-event="${escapeHtml(
          event.type,
        )}" data-attempt="${escapeHtml(event.attemptId)}">
          <span class="log-time">+${String(event.at).padStart(3, "0")}ms</span>
          <span class="log-event">${escapeHtml(event.type)}</span>
          <span class="log-attempt">${escapeHtml(event.attemptId)}</span>
          <span class="log-detail">${escapeHtml(event.detail)}</span>
        </div>
      `,
    )
    .join("");

  els.eventLog.scrollTop = els.eventLog.scrollHeight;
}

function eventClass(type) {
  if (type === "quota.rejected") {
    return "is-reject";
  }
  if (type === "quota.refunded") {
    return "is-refund";
  }
  if (type.startsWith("mock-ai.")) {
    return "is-provider";
  }
  if (type === "plan.saved") {
    return "is-plan";
  }
  if (type.startsWith("quota.")) {
    return "is-quota";
  }
  return "";
}

/* -------------------------------- timeline -------------------------------- */

function renderTimeline() {
  if (!state.attempts.length && !state.precheckBlocked) {
    els.timeline.innerHTML =
      '<p class="empty-state">运行场景后，在这里看到预占、调用与结算路径。</p>';
    return;
  }

  const rows = [];

  if (state.precheckBlocked) {
    rows.push(`
      <div class="timeline-attempt" data-pseudo="precheck">
        <div class="timeline-head">
          <div class="timeline-label">
            <span class="lane-label">页面</span>
            <span class="lane-source">按钮预检</span>
            <span class="lane-attempt">无请求</span>
          </div>
          <span class="timeline-outcome is-refused">提前拦截</span>
        </div>
        <div class="timeline-steps">
          <span class="timeline-step is-neutral">余额 0 · 按钮停用</span>
          <span class="timeline-step is-neutral">未发出请求</span>
        </div>
        <p class="timeline-note">前端预检改善体验；下面的直连请求验证服务端仍会拒绝。</p>
      </div>
    `);
  }

  for (const attempt of state.attempts) {
    rows.push(`
      <div class="timeline-attempt${attempt.primary ? " is-primary" : ""}" data-attempt="${
        escapeHtml(attempt.id)
      }">
        <div class="timeline-head">
          <div class="timeline-label">
            <span class="lane-label">${escapeHtml(attempt.lane)}</span>
            <span class="lane-source">${escapeHtml(attempt.source)}</span>
            <span class="lane-attempt">${escapeHtml(attempt.id)}</span>
          </div>
          <span class="timeline-outcome ${outcomeClass(attempt.status)}">${outcomeLabel(
            attempt.status,
          )}</span>
        </div>
        <div class="timeline-steps">
          ${attempt.steps
            .map(
              (step) =>
                `<span class="timeline-step is-${step.state}">${escapeHtml(step.label)}</span>`,
            )
            .join("")}
        </div>
        ${
          attempt.note
            ? `<p class="timeline-note">${escapeHtml(attempt.note)}</p>`
            : ""
        }
      </div>
    `);
  }

  els.timeline.innerHTML = rows.join("");
}

function outcomeClass(status) {
  if (status === "success") {
    return "is-success";
  }
  if (status === "rejected" || status === "unknown") {
    return "is-refused";
  }
  if (status === "refunded") {
    return "is-refunded";
  }
  return "is-pending";
}

function outcomeLabel(status) {
  if (status === "success") {
    return "成功";
  }
  if (status === "rejected") {
    return "已拒绝";
  }
  if (status === "refunded") {
    return "已返还";
  }
  if (status === "unknown") {
    return "待确认";
  }
  return "处理中…";
}

function getServerAttemptCount() {
  return els.timeline.querySelectorAll(
    ".timeline-attempt[data-attempt]:not([data-pseudo])",
  ).length;
}

/* ------------------------------- invariants ------------------------------- */

function renderInvariants() {
  const hasAttempts = state.attempts.length > 0;
  const inFlight = state.attempts.some(
    (attempt) => attempt.status === "pending",
  );

  if (!hasAttempts) {
    setInvariant("balance", "idle", "等待运行");
    setInvariant("reservation", "idle", "等待运行");
    setInvariant("reconcile", "idle", "等待运行");
    els.reconciliation.textContent =
      "初始额度 − 预占次数 + 返还次数 = 当前余额";
    els.reconciliation.classList.remove("is-pass", "is-fail");
    return;
  }

  if (inFlight) {
    setInvariant("balance", "checking", "结算中…");
    setInvariant("reservation", "checking", "结算中…");
    setInvariant("reconcile", "checking", "结算中…");
    els.reconciliation.textContent = `结算中 · 初始 ${state.initialCredits} − 预占 ${state.reservations} + 返还 ${state.refunds} → 当前 ${state.credits}`;
    els.reconciliation.classList.remove("is-pass", "is-fail");
    return;
  }

  const balanceOk = state.credits >= 0;
  const reservedAtByAttempt = new Map();
  state.events.forEach((event, index) => {
    if (
      event.type === "quota.reserved" &&
      !reservedAtByAttempt.has(event.attemptId)
    ) {
      reservedAtByAttempt.set(event.attemptId, index);
    }
  });
  const callsWithoutReservation = state.events.reduce((count, event, index) => {
    if (event.type !== "mock-ai.started") {
      return count;
    }
    const reservedAt = reservedAtByAttempt.get(event.attemptId);
    return reservedAt === undefined || reservedAt > index ? count + 1 : count;
  }, 0);
  const reservationOk = callsWithoutReservation === 0;
  const reconciled =
    state.credits ===
    state.initialCredits - state.reservations + state.refunds;

  setInvariant(
    "balance",
    balanceOk ? "pass" : "fail",
    balanceOk ? `余额 ${state.credits} · ≥ 0` : `余额 ${state.credits} · 小于 0`,
  );
  setInvariant(
    "reservation",
    reservationOk ? "pass" : "fail",
    reservationOk
      ? `调用 ${state.providerCalls} / 预占 ${state.reservations} · 越过 0`
      : `越过预占 ${callsWithoutReservation} 次`,
  );
  setInvariant(
    "reconcile",
    reconciled ? "pass" : "fail",
    reconciled ? `已验证 · 当前 ${state.credits}` : "等式不平衡",
  );

  els.reconciliation.textContent = `初始 ${state.initialCredits} − 预占 ${state.reservations} + 返还 ${state.refunds} = 当前 ${state.credits} ${
    reconciled ? "✓ 对账通过" : "× 对账不平衡"
  }`;
  els.reconciliation.classList.toggle("is-pass", reconciled);
  els.reconciliation.classList.toggle("is-fail", !reconciled);
}

function setInvariant(name, status, value) {
  const row = els.invariants.querySelector(
    `[data-invariant="${name}"]`,
  );
  if (!row) {
    return;
  }

  row.dataset.status = status;
  const mark = row.querySelector(".invariant-mark");
  const valueEl = row.querySelector(".invariant-value");
  if (mark) {
    mark.textContent =
      status === "pass" ? "✓" : status === "fail" ? "×" : status === "checking" ? "…" : "·";
  }
  if (valueEl) {
    valueEl.textContent = value;
  }
}

/* -------------------------------- receipts -------------------------------- */

function renderPendingStatus() {
  els.statusRegion.innerHTML = `
    <div class="receipt-pending" data-testid="pending-status">
      <span class="pending-dots" aria-hidden="true"><span></span><span></span><span></span></span>
      <span>正在生成，成功后扣除 1 个额度；失败会自动返还。</span>
    </div>
  `;
}

function renderSuccessReceipt(attemptId) {
  const nextAction =
    state.credits === 0 ? "查看本次日程；额度已用完" : "查看本次日程";
  els.statusRegion.innerHTML = receiptMarkup({
    kind: "success",
    icon: "✓",
    title: "本次生成成功",
    delta: "−1 额度",
    main: `日程已生成，已扣除 1 个额度；当前余额 <strong>${state.credits}</strong> 个。`,
    attemptId,
    nextAction,
  });
}

function renderFailureReceipt(attemptId) {
  els.statusRegion.innerHTML = receiptMarkup({
    kind: "failure",
    icon: "!",
    title: "本次生成失败",
    delta: "净扣 0 · 返还 1",
    main: `生成失败，本次未扣除额度，1 个额度已自动返还；当前余额 <strong>${state.credits}</strong> 个。`,
    attemptId,
    nextAction: "检查任务后重试",
    retry: true,
  });
}

function renderInsufficientReceipt(attemptId) {
  els.statusRegion.innerHTML = receiptMarkup({
    kind: "warning",
    icon: "!",
    title: "本次未发起生成",
    delta: "净扣 0",
    main: `额度不足，本次未发起生成，也未扣除额度；当前余额 <strong>${state.credits}</strong> 个。请联系管理员补充额度后刷新页面重试。`,
    attemptId,
    nextAction: "补充额度后刷新页面",
  });
}

function renderUnknownReceipt(attemptId) {
  els.statusRegion.innerHTML = receiptMarkup({
    kind: "unknown",
    icon: "?",
    title: "本次未完成",
    delta: "待确认",
    main: "生成未完成，额度状态待确认。请刷新页面查看余额；如余额有扣减但未生成日程，请联系管理员。",
    attemptId,
    nextAction: "刷新页面核对余额",
  });
}

function receiptMarkup({
  kind,
  icon,
  title,
  delta,
  main,
  attemptId,
  nextAction,
  retry = false,
}) {
  return `
    <article class="receipt receipt--${kind}" data-testid="receipt" data-receipt-kind="${kind}">
      <div class="receipt-head">
        <p class="receipt-kicker">
          <span class="receipt-icon" aria-hidden="true">${icon}</span>
          ${escapeHtml(title)}
        </p>
        <span class="receipt-delta">${escapeHtml(delta)}</span>
      </div>
      <p class="receipt-main">${main}</p>
      <div class="receipt-meta">
        <span class="receipt-id">凭证 ${escapeHtml(attemptId)}</span>
        <span class="receipt-next">下一步：${escapeHtml(nextAction)}</span>
      </div>
      ${
        retry
          ? `<div class="receipt-actions"><button class="receipt-retry" type="button" data-action="retry">重试本次生成</button></div>`
          : ""
      }
    </article>
  `;
}

function getReceiptKind() {
  return (
    els.statusRegion.querySelector('[data-testid="receipt"]')?.dataset
      .receiptKind ?? "none"
  );
}

/* -------------------------------- schedule -------------------------------- */

function buildSchedule() {
  const availableHours = clampNumber(parseFloat(els.hours.value), 1, 24, 8);
  const totalTaskHours = 3.5;
  const effectiveHours = Math.min(availableHours, totalTaskHours);
  const tasks = [
    {
      name: "整理项目周报素材",
      hours: 1.5,
      priority: "中优先级",
      steps: ["汇总本周进展", "提取关键数据", "写成三段摘要"],
    },
    {
      name: "准备周五方案评审",
      hours: 2,
      priority: "高优先级",
      steps: ["列出需要拍板的 3 个问题", "补充风险与备选方案", "整理评审提纲"],
    },
  ];

  let cursor = 9 * 60;
  const items = tasks.map((task, index) => {
    const duration = Math.max(
      15,
      Math.round(((task.hours / totalTaskHours) * effectiveHours * 60) / 5) * 5,
    );
    const start = cursor;
    const end = start + duration;
    cursor = end + (index < tasks.length - 1 ? 15 : 0);
    const stepMinutes = Math.max(5, Math.round(duration / 3 / 5) * 5);

    return {
      ...task,
      start,
      end,
      steps: task.steps.map((name) => ({ name, minutes: stepMinutes })),
    };
  });

  return {
    items,
    availableHours,
    footnote:
      availableHours < totalTaskHours
        ? `模拟日程 · 已按 ${availableHours} 小时可用时间压缩`
        : `模拟日程 · 按 ${availableHours} 小时可用时间安排，含 15 分钟切换缓冲`,
  };
}

function renderSchedule() {
  if (!state.lastSchedule) {
    els.resultSection.hidden = true;
    return;
  }

  els.resultSection.hidden = false;
  els.resultSection.classList.toggle(
    "is-previous",
    state.lastScheduleIsPrevious,
  );
  els.resultTitle.textContent = state.lastScheduleIsPrevious
    ? "上次日程"
    : "本次日程";
  els.resultBadge.textContent = state.lastScheduleIsPrevious
    ? "历史结果"
    : "AI 生成";

  const { items, footnote } = state.lastSchedule;
  els.schedule.innerHTML =
    items
      .map(
        (item) => `
          <article class="schedule-item">
            <div class="schedule-item-head">
              <span class="schedule-time">${formatTime(item.start)} – ${formatTime(item.end)}</span>
              <span class="schedule-priority${item.priority === "高优先级" ? " is-high" : ""}">${escapeHtml(
                item.priority,
              )}</span>
            </div>
            <h4>${escapeHtml(item.name)}</h4>
            <ul class="schedule-steps">
              ${item.steps
                .map(
                  (step) =>
                    `<li>${escapeHtml(step.name)} <span class="step-time">${step.minutes}m</span></li>`,
                )
                .join("")}
            </ul>
          </article>
        `,
      )
      .join("") + `<p class="schedule-footnote">${escapeHtml(footnote)}</p>`;
}

function formatTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/* ------------------------------- product UI -------------------------------- */

function renderProductState() {
  const hasCredits = state.credits > 0;

  els.balanceValue.textContent = String(state.credits);
  els.hintCredits.textContent = String(state.credits);
  els.balanceChip.classList.toggle("is-low", state.credits === 1);
  els.balanceChip.classList.toggle("is-empty", state.credits <= 0);
  els.costHint.hidden = !hasCredits;
  els.lastCreditHint.hidden = state.credits !== 1;
  els.zeroNotice.hidden = hasCredits;

  renderTaskDisplay();
  renderSchedule();
  updateInteractionState();
}

function renderTaskDisplay() {
  els.task2Row.classList.toggle("is-fail", state.failInjected);
  els.failChip.hidden = !state.failInjected;
  els.task2Name.textContent = state.failInjected
    ? "[fail] 准备周五方案评审"
    : "准备周五方案评审";
  els.task2Meta.textContent = state.failInjected
    ? "预计 2 小时 · 模型将返回失败"
    : "预计 2 小时";
}

function updateInteractionState() {
  const busy = Boolean(activeRun) || state.running;
  const generateBusy = busy || state.primaryPending || state.credits <= 0;

  for (const button of els.scenarioButtons) {
    button.disabled = busy;
  }
  els.runAll.disabled = busy;
  els.resetDemo.disabled = busy;
  els.failToggle.disabled = busy;
  els.failToggle.checked = state.failInjected;

  els.generateBtn.disabled = generateBusy;
  els.generateLabel.textContent = state.primaryPending
    ? "生成中…"
    : state.credits <= 0
      ? "额度已用完"
      : "生成日程";
  els.buttonSpinner.hidden = !state.primaryPending;
  els.generateBtn.setAttribute("aria-busy", String(state.primaryPending));

  const retryButton = els.statusRegion.querySelector('[data-action="retry"]');
  if (retryButton) {
    retryButton.disabled = busy || state.credits <= 0;
  }
}

/* ---------------------------- results & rendering -------------------------- */

function evaluateScenario(id) {
  const scenario = SCENARIOS[id];
  const expected = scenario.expected;
  const counterKeys = [
    "credits",
    "providerCalls",
    "successes",
    "failures",
    "refusals",
    "refunds",
    "reservations",
  ];
  const countersMatch = counterKeys.every(
    (key) => state[key] === expected[key],
  );
  const uiMatches = scenario.uiCheck();
  const pass = countersMatch && uiMatches;

  return {
    id,
    name: scenario.name,
    expectedLabel: scenario.expectedLabel,
    actualLabel: scenario.actualLabel(),
    status: pass ? "pass" : "fail",
  };
}

function renderScenarioResults() {
  if (state.results.size === 0) {
    els.scenarioResults.innerHTML =
      '<p class="empty-state">尚未运行场景。</p>';
    return;
  }

  const rows = [];
  for (const id of SCENARIO_ORDER) {
    const result = state.results.get(id);
    if (!result) {
      continue;
    }

    rows.push(`
      <div class="result-row" data-scenario-result="${escapeHtml(
        id,
      )}" data-status="${result.status}">
        <div class="result-row-top">
          <span class="result-row-id">${escapeHtml(id)}</span>
          <span class="result-row-name">${escapeHtml(result.name)}</span>
          <span class="result-row-status">${
            result.status === "pass" ? "通过" : "未通过"
          }</span>
        </div>
        <p class="result-row-detail"><strong>期望</strong> ${escapeHtml(
          result.expectedLabel,
        )}</p>
        <p class="result-row-detail"><strong>实际</strong> ${escapeHtml(
          result.actualLabel,
        )}</p>
      </div>
    `);
  }

  els.scenarioResults.innerHTML = rows.join("");
}

function renderLabRunStatus(message) {
  els.labRunStatus.textContent = message;
}

function renderAll() {
  renderProductState();
  renderTimeline();
  renderEventLog();
  renderInvariants();
  renderScenarioResults();
  updateInteractionState();
}

/* ---------------------------------- utils --------------------------------- */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
