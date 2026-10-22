/*
 * 额度原型的最小模型。
 *
 * 浏览器：index.html 以 classic script 加载，挂到 globalThis.QuotaModel。
 * Node：quota-model.test.mjs 以 import "./quota-model.js" 触发副作用后读取
 *       globalThis.QuotaModel，因此不需要额外依赖或构建步骤。
 *
 * 重要：reserve() 是同步的，模拟数据库的原子条件更新
 *       UPDATE User SET credits = credits - 1 WHERE id = ? AND credits > 0。
 * 并发演示时，多个 attemptGeneration 会先同步执行 reserve()，再 await 模型；
 * 因而只有前 N 个请求能拿到额度，和真实数据库的行锁语义一致。
 */
(function (global) {
  "use strict";

  const DEFAULT_TASKS = [
    { id: "task-1", description: "整理季度复盘材料", time: 1.5, done: false },
    { id: "task-2", description: "预约牙医", time: 0.5, done: false },
    { id: "task-3", description: "阅读《设计心理学》", time: 1, done: false },
  ];

  let callSequence = 0;

  function nextCallId() {
    callSequence += 1;
    return "call-" + String(callSequence).padStart(3, "0");
  }

  function resetCallSequence() {
    callSequence = 0;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  class QuotaStore {
    constructor(credits = 3) {
      this.credits = credits;
    }

    /** 原子预扣：没有额度返回 null；成功返回预扣后的余额。 */
    reserve() {
      if (this.credits <= 0) return null;
      this.credits -= 1;
      return this.credits;
    }

    /** 失败退款：只应由已经 reserve 成功的请求调用。 */
    refund() {
      this.credits += 1;
      return this.credits;
    }
  }

  function emit(onEvent, event) {
    if (typeof onEvent !== "function") return;
    try {
      onEvent(event);
    } catch (_error) {
      // 日志失败不能影响额度流程。
    }
  }

  /**
   * 执行一次生成尝试。
   *
   * 返回 status:
   * - success: 模型成功，额度已扣
   * - insufficient: 额度不足，未调用模型
   * - failed: 模型失败，已退款
   */
  async function attemptGeneration(store, options) {
    const {
      tasks = [],
      hours = 8,
      provider,
      onEvent,
      requestId = "req",
      staggerMs = 0,
    } = options || {};

    if (!(store instanceof QuotaStore)) {
      throw new Error("attemptGeneration requires a QuotaStore");
    }
    if (typeof provider !== "function") {
      throw new Error("attemptGeneration requires a provider");
    }

    // 模拟并发请求的到达时间；必须在 reserve 之前等待，后到请求才会看到已扣余额。
    if (staggerMs > 0) await wait(staggerMs);

    emit(onEvent, { type: "request.received", requestId });

    const remainingAtReserve = store.reserve();
    if (remainingAtReserve === null) {
      emit(onEvent, {
        type: "credit.insufficient",
        requestId,
        remaining: store.credits,
      });
      return {
        requestId,
        status: "insufficient",
        remainingAtReserve: null,
        remaining: store.credits,
      };
    }

    emit(onEvent, {
      type: "credit.reserved",
      requestId,
      remaining: remainingAtReserve,
    });

    const callId = nextCallId();
    emit(onEvent, { type: "mock-ai.started", requestId, callId });

    try {
      const schedule = await provider({ tasks, hours, requestId, callId });
      emit(onEvent, { type: "mock-ai.succeeded", requestId, callId });
      return {
        requestId,
        status: "success",
        schedule,
        callId,
        remainingAtReserve,
        remaining: store.credits,
      };
    } catch (error) {
      const refundedTo = store.refund();
      emit(onEvent, {
        type: "mock-ai.failed",
        requestId,
        callId,
        message: String((error && error.message) || error),
      });
      emit(onEvent, {
        type: "credit.refunded",
        requestId,
        remaining: refundedTo,
      });
      return {
        requestId,
        status: "failed",
        error,
        callId,
        remainingAtReserve,
        remaining: refundedTo,
      };
    }
  }

  /**
   * 并发执行 N 个请求。
   * 每个请求的 reserve 在 await provider 之前同步完成，因此结果等价于
   * “数据库条件更新 + 模型调用”的并发语义。
   */
  async function simulateConcurrentRequests(options) {
    const {
      credits = 3,
      requestCount = 3,
      tasks = [],
      hours = 8,
      provider,
      onEvent,
      staggerMs = 0,
    } = options || {};

    const store = new QuotaStore(credits);
    const results = await Promise.all(
      Array.from({ length: requestCount }, (_, index) =>
        attemptGeneration(store, {
          tasks,
          hours,
          provider,
          onEvent,
          requestId: "req-" + (index + 1),
          staggerMs: staggerMs * index,
        }),
      ),
    );

    return { store, results, credits: store.credits };
  }

  global.QuotaModel = Object.freeze({
    DEFAULT_TASKS,
    QuotaStore,
    attemptGeneration,
    simulateConcurrentRequests,
    nextCallId,
    resetCallSequence,
    wait,
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
