import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NoCreditError,
  RefundFailedError,
  ReservationStateUnknownError,
  runWithReservedCredit,
} from "../src/demo-ai-app/quota.ts";

function makeStore(initialCredits) {
  let credits = initialCredits;
  return {
    get credits() {
      return credits;
    },
    async reserveCredit() {
      if (credits <= 0) return false;
      credits -= 1;
      return true;
    },
    async refundCredit() {
      credits += 1;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("success consumes exactly one credit", async () => {
  const store = makeStore(3);
  const result = await runWithReservedCredit(store, "user", async () => "plan");
  assert.equal(result, "plan");
  assert.equal(store.credits, 2);
});

test("zero credits never starts work", async () => {
  const store = makeStore(0);
  let started = 0;
  await assert.rejects(
    runWithReservedCredit(store, "user", async () => {
      started += 1;
    }),
    NoCreditError,
  );
  assert.equal(started, 0);
  assert.equal(store.credits, 0);
});

test("provider or persistence failure restores the reservation", async () => {
  for (const reason of ["provider", "persistence"]) {
    const store = makeStore(1);
    await assert.rejects(
      runWithReservedCredit(store, "user", async () => {
        throw new Error(reason);
      }),
      { message: reason },
    );
    assert.equal(store.credits, 1);
  }
});

test("parallel requests cannot pass the final credit while one is running", async () => {
  const store = makeStore(1);
  const started = deferred();
  const release = deferred();
  let providerCalls = 0;
  const first = runWithReservedCredit(store, "user", async () => {
    providerCalls += 1;
    started.resolve();
    await release.promise;
    return "plan";
  });
  await started.promise;

  await assert.rejects(
    runWithReservedCredit(store, "user", async () => {
      providerCalls += 1;
    }),
    NoCreditError,
  );
  assert.equal(providerCalls, 1);
  assert.equal(store.credits, 0);
  release.resolve();
  await first;
  assert.equal(store.credits, 0);
});

test("parallel failure releases the credit for a later retry", async () => {
  const store = makeStore(1);
  const started = deferred();
  const release = deferred();
  let providerCalls = 0;
  const first = runWithReservedCredit(store, "user", async () => {
    providerCalls += 1;
    started.resolve();
    await release.promise;
    throw new Error("provider failed");
  });
  await started.promise;
  await assert.rejects(
    runWithReservedCredit(store, "user", async () => {
      providerCalls += 1;
    }),
    NoCreditError,
  );
  assert.equal(providerCalls, 1);
  release.resolve();
  await assert.rejects(first, { message: "provider failed" });
  assert.equal(store.credits, 1);
  await runWithReservedCredit(store, "user", async () => {
    providerCalls += 1;
  });
  assert.equal(providerCalls, 2);
  assert.equal(store.credits, 0);
});

test("unknown reservation and failed refund are not reported as clean failures", async () => {
  const reserveError = new Error("database unavailable");
  await assert.rejects(
    runWithReservedCredit(
      {
        reserveCredit: async () => {
          throw reserveError;
        },
        refundCredit: async () => {},
      },
      "user",
      async () => "plan",
    ),
    ReservationStateUnknownError,
  );
  await assert.rejects(
    runWithReservedCredit(
      {
        reserveCredit: async () => true,
        refundCredit: async () => {
          throw new Error("refund unavailable");
        },
      },
      "user",
      async () => {
        throw new Error("provider failed");
      },
    ),
    RefundFailedError,
  );
});
