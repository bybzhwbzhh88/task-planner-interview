/* Product demonstration only. No HTTP requests, database, or real model calls. */
(() => {
  class QuotaModel {
    constructor({ credits = 3, delay = 1400, autoComplete = true } = {}) {
      this.delay = delay;
      this.autoComplete = autoComplete;
      this.listeners = new Set();
      this.pending = new Map();
      this.reset(credits);
    }

    reset(credits = 3) {
      if (!Number.isInteger(credits) || credits < 0) throw new Error("Invalid credits");
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.resolve({ status: "cancelled" });
      }
      this.remaining = credits;
      this.initial = credits;
      this.pending.clear();
      this.history = [];
      this.events = [];
      this.sequence = 0;
      this.record("prototype.reset", { credits });
    }

    snapshot() {
      return {
        remaining: this.remaining,
        reserved: this.pending.size,
        available: this.remaining - this.pending.size,
        history: this.history.map((item) => ({ ...item, tasks: [...item.tasks] })),
        calls: this.events.filter((event) => event.event === "prototype.model.started").length,
      };
    }

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    record(event, detail = {}) {
      this.events.push({ event, ...detail });
      const state = this.snapshot();
      if (state.available < 0 || state.remaining < 0 || state.reserved > state.remaining) {
        throw new Error("Prototype quota invariant violated");
      }
      for (const listener of this.listeners) listener(state);
    }

    start({ tab, tasks, hours, outcome = "success" }) {
      if (!["success", "save-failure", "response-lost"].includes(outcome)) {
        throw new Error("Unknown demo outcome");
      }
      const cleaned = tasks.map((task) => task.trim()).filter(Boolean);
      const reject = (status) => {
        this.record("prototype.rejected", { tab, reason: status });
        return { accepted: false, done: Promise.resolve({ status }) };
      };
      if (!cleaned.length || !Number.isFinite(hours) || hours < 1 || hours > 24) {
        return reject("invalid");
      }
      if (this.snapshot().available === 0) {
        return reject(this.pending.size ? "busy" : "exhausted");
      }

      // Synchronous reservation models the required atomic server decision.
      // JavaScript memory is a demonstration, not a database concurrency solution.
      const id = `D${++this.sequence}`;
      let resolve;
      const done = new Promise((complete) => { resolve = complete; });
      const request = { id, tab, tasks: cleaned, hours, outcome, resolve };
      this.pending.set(id, request);
      this.record("prototype.reserved", { id, tab });
      this.record("prototype.model.started", { id, tab });
      if (this.autoComplete) request.timer = setTimeout(() => this.finish(id), this.delay);
      return { id, accepted: true, done };
    }

    finish(id) {
      const request = this.pending.get(id);
      if (!request) return false;
      clearTimeout(request.timer);
      const { tab, tasks, hours, outcome } = request;
      let response;
      if (tasks.some((task) => task.includes("[fail]"))) {
        this.record("prototype.model.failed", { id, tab });
        this.pending.delete(id);
        this.record("prototype.released", { id, tab });
        response = { status: "model-failure", id };
      } else {
        this.record("prototype.model.succeeded", { id, tab });
        if (outcome === "save-failure") {
          this.pending.delete(id);
          this.record("prototype.save.failed", { id, tab });
          response = { status: "save-failure", id };
        } else {
          // Result and final charge become visible together in this simulation.
          this.pending.delete(id);
          this.remaining -= 1;
          const result = { id, tab, tasks: [...tasks], hours };
          this.history.unshift(result);
          this.record("prototype.committed", { id, tab });
          response = outcome === "response-lost"
            ? { status: "unknown", id }
            : { status: "success", id, result };
        }
      }
      request.resolve(response);
      return true;
    }
  }

  globalThis.QuotaPrototype = { QuotaModel };
})();
