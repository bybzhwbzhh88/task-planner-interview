import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QuotaError,
  createPrismaCreditStore,
  executeWithQuota,
} from '../src/demo-ai-app/creditQuota.ts';

class FakeCredits {
  constructor(initial) {
    this.balance = initial;
    this.minimum = initial;
    this.releaseCount = 0;
    this.reserveCount = 0;
    this.failReserve = false;
    this.failRelease = false;
  }
  async reserve() {
    if (this.failReserve) throw Error('db connection failed');
    // Deliberately synchronous; this only verifies orchestration, NOT real DB atomicity.
    if (this.balance === 0) return false;
    this.reserveCount++;
    this.balance--;
    this.minimum = Math.min(this.minimum, this.balance);
    return true;
  }
  async release() {
    if (this.failRelease) throw Error('db connection failed');
    this.balance++;
    this.releaseCount++;
  }
}
const options = (store, overrides = {}) => ({
  store,
  userId: 'user-test',
  generate: async () => ({ tasks: [], taskItems: [] }),
  save: async () => {},
  ...overrides,
});
async function rejectsCode(fn, code) {
  await assert.rejects(fn, (error) => {
    assert.ok(error instanceof QuotaError);
    assert.equal(error.code, code);
    return true;
  });
}

test('A01: success spends one credit and returns generated schedule', async () => {
  const store = new FakeCredits(2);
  let saved = 0;
  const plan = await executeWithQuota(options(store, {
    save: async () => { saved++; },
  }));
  assert.deepEqual(plan, { tasks: [], taskItems: [] });
  assert.equal(saved, 1);
  assert.equal(store.balance, 1);
  assert.equal(store.reserveCount, 1);
  assert.equal(store.releaseCount, 0);
});

test('A02: 0 credits prevents both provider invocation and persistence', async () => {
  const store = new FakeCredits(0);
  let provider = 0;
  let saved = 0;
  await rejectsCode(() => executeWithQuota(options(store, {
    generate: async () => { provider++; return 'plan'; },
    save: async () => { saved++; },
  })), 'CREDITS_EXHAUSTED');
  assert.equal(provider, 0);
  assert.equal(saved, 0);
  assert.equal(store.balance, 0);
});

test('A03: provider rejection refunds exactly once; save not called', async () => {
  const store = new FakeCredits(1);
  let saved = 0;
  await rejectsCode(() => executeWithQuota(options(store, {
    generate: async () => { throw Error('mock-ai.failed'); },
    save: async () => { saved++; },
  })), 'GENERATION_FAILED');
  assert.equal(store.balance, 1);
  assert.equal(store.releaseCount, 1);
  assert.equal(saved, 0);
});

test('A03: provider returning null is a failure and refunds', async () => {
  const store = new FakeCredits(1);
  await rejectsCode(() => executeWithQuota(options(store, {
    generate: async () => null,
  })), 'GENERATION_FAILED');
  assert.equal(store.balance, 1);
});

test('A04: result persistence failure refunds once', async () => {
  const store = new FakeCredits(1);
  await rejectsCode(() => executeWithQuota(options(store, {
    save: async () => { throw Error('write failed'); },
  })), 'PERSISTENCE_FAILED');
  assert.equal(store.balance, 1);
  assert.equal(store.releaseCount, 1);
});

test('A05: 10 simultaneous requests with 1 credit: exactly one calls provider', async () => {
  const store = new FakeCredits(1);
  let provider = 0;
  let saved = 0;
  const batch = await Promise.allSettled(Array.from({ length: 10 }, () => executeWithQuota(options(store, {
    generate: async () => {
      provider++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return 'plan';
    },
    save: async () => { saved++; },
  }))));
  assert.equal(batch.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(batch.filter(r => r.status === 'rejected').length, 9);
  assert.equal(provider, 1);
  assert.equal(saved, 1);
  assert.equal(store.balance, 0);
  assert.ok(store.minimum >= 0);
});

test('A06: 50 simultaneous requests with 3 credits: exactly 3 successful', async () => {
  const store = new FakeCredits(3);
  let provider = 0;
  let saved = 0;
  const batch = await Promise.allSettled(Array.from({ length: 50 }, () => executeWithQuota(options(store, {
    generate: async () => { provider++; return 'plan'; },
    save: async () => { saved++; },
  }))));
  assert.equal(batch.filter(r => r.status === 'fulfilled').length, 3);
  assert.equal(provider, 3);
  assert.equal(saved, 3);
  assert.equal(store.balance, 0);
  assert.ok(store.minimum >= 0);
});

test('A07: reservation infrastructure failure does not start provider', async () => {
  const store = new FakeCredits(1);
  store.failReserve = true;
  let provider = 0;
  await rejectsCode(() => executeWithQuota(options(store, {
    generate: async () => { provider++; return 'plan'; },
  })), 'CREDIT_CHECK_FAILED');
  assert.equal(provider, 0);
  assert.equal(store.balance, 1);
});

test('A08: refund failure reports uncertain state and retains original error', async () => {
  const store = new FakeCredits(1);
  store.failRelease = true;
  await assert.rejects(() => executeWithQuota(options(store, {
    generate: async () => { throw Error('provider failed'); },
  })), (e) => {
    assert.equal(e.code, 'CREDIT_REFUND_FAILED');
    assert.equal(e.cause.originalError.message, 'provider failed');
    assert.equal(e.cause.refundError.message, 'db connection failed');
    return true;
  });
  assert.equal(store.balance, 0);
});

test('Prisma adapter: uses conditional atomic UPDATE and 1-unit refund', async () => {
  const calls = [];
  const store = createPrismaCreditStore({
    async updateMany(args) { calls.push(['reserve', args]); return { count: 1 }; },
    async update(args) { calls.push(['release', args]); return {}; },
  });
  assert.equal(await store.reserve('user-test'), true);
  await store.release('user-test');
  assert.deepEqual(calls, [
    ['reserve', { where: { id: 'user-test', credits: { gt: 0 } }, data: { credits: { decrement: 1 } } }],
    ['release', { where: { id: 'user-test' }, data: { credits: { increment: 1 } } }],
  ]);
});

test('Prisma adapter: count=0 means no credits', async () => {
  const store = createPrismaCreditStore({
    async updateMany() { return { count: 0 }; },
    async update() { throw Error('unexpected refund'); },
  });
  assert.equal(await store.reserve('user-test'), false);
});

test('Prisma adapter: count>1 is an infrastructure error', async () => {
  const store = createPrismaCreditStore({
    async updateMany() { return { count: 2 }; },
    async update() { throw Error('unexpected refund'); },
  });
  await assert.rejects(() => store.reserve('user-test'), /Unexpected quota update count/);
});

test('missing userId rejected before reserving', async () => {
  const store = new FakeCredits(1);
  await assert.rejects(() => executeWithQuota(options(store, { userId: '' })), /Authenticated user ID/);
  assert.equal(store.reserveCount, 0);
});
