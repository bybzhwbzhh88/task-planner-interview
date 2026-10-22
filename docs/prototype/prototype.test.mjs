import './model.js';
import assert from 'node:assert/strict';
import test from 'node:test';

const { QuotaModel } = globalThis.QuotaPrototype;
const model = (credits) => new QuotaModel({ credits, autoComplete: false });
const input = (overrides = {}) => ({ tab: 'A', tasks: ['准备项目方案'], hours: 8, ...overrides });

test('P01 / AC01: success reserves first, then saves and charges once', async () => {
  const quota = model(3);
  const request = quota.start(input());
  assert.deepEqual(quota.snapshot(), { remaining: 3, reserved: 1, available: 2, history: [], calls: 1 });
  quota.finish(request.id);
  assert.equal((await request.done).status, 'success');
  assert.equal(quota.snapshot().remaining, 2);
  assert.equal(quota.snapshot().reserved, 0);
  assert.equal(quota.snapshot().history.length, 1);
  assert.equal(quota.finish(request.id), false);
  assert.equal(quota.snapshot().remaining, 2);
});

test('P02 / AC02: zero credits never starts a simulated call', async () => {
  const quota = model(0);
  const request = quota.start(input());
  assert.equal(request.accepted, false);
  assert.equal((await request.done).status, 'exhausted');
  assert.equal(quota.snapshot().calls, 0);
});

test('P03 / AC03,07: stale windows compete for one credit; loser does not queue', async () => {
  const quota = model(1);
  const staleA = quota.snapshot(), staleB = quota.snapshot();
  assert.equal(staleA.available, staleB.available);
  const first = quota.start(input());
  const second = quota.start(input({ tab: 'B' }));
  assert.equal((await second.done).status, 'busy');
  assert.equal(quota.snapshot().calls, 1);
  quota.finish(first.id);
  assert.equal(quota.snapshot().available, 0);
  const third = quota.start(input({ tab: 'B' }));
  assert.equal((await third.done).status, 'exhausted');
  assert.equal(quota.snapshot().calls, 1);
  assert.equal(quota.snapshot().history.length, 1);
});

test('P04 / AC04: five simultaneous intentions admit only three', async () => {
  const quota = model(3);
  const observed = [];
  quota.subscribe((state) => observed.push(state.available));
  const requests = Array.from({ length: 5 }, (_, index) => quota.start(input({ tab: `W${index}` })));
  assert.equal(requests.filter((request) => request.accepted).length, 3);
  for (const request of requests) if (request.accepted) quota.finish(request.id);
  const results = await Promise.all(requests.map((request) => request.done));
  assert.equal(results.filter((result) => result.status === 'success').length, 3);
  assert.equal(quota.snapshot().calls, 3);
  assert.equal(quota.snapshot().remaining, 0);
  assert.equal(quota.snapshot().reserved, 0);
  assert.ok(observed.every((available) => available >= 0));
});

test('P05 / AC05: clear model failure releases credit and permits a fresh retry', async () => {
  const quota = model(1);
  const request = quota.start(input({ tasks: ['任务 [fail]'] }));
  quota.finish(request.id);
  assert.equal((await request.done).status, 'model-failure');
  assert.equal(quota.snapshot().available, 1);
  assert.equal(quota.snapshot().history.length, 0);
  const retry = quota.start(input());
  quota.finish(retry.id);
  assert.equal((await retry.done).status, 'success');
  assert.equal(quota.snapshot().calls, 2);
  assert.equal(quota.snapshot().remaining, 0);
});

test('P06 / AC06: a failed save leaves no result or final charge', async () => {
  const quota = model(1);
  const request = quota.start(input({ outcome: 'save-failure' }));
  quota.finish(request.id);
  assert.equal((await request.done).status, 'save-failure');
  assert.equal(quota.snapshot().remaining, 1);
  assert.equal(quota.snapshot().reserved, 0);
  assert.equal(quota.snapshot().history.length, 0);
  assert.equal(quota.snapshot().calls, 1);
});

for (const failureFirst of [false, true]) {
  test(`P07${failureFirst ? 'b' : 'a'} / AC08: mixed completion order, failure first = ${failureFirst}`, async () => {
    const quota = model(2);
    const success = quota.start(input());
    const failure = quota.start(input({ tab: 'B', tasks: ['失败 [fail]'] }));
    for (const request of failureFirst ? [failure, success] : [success, failure]) quota.finish(request.id);
    assert.equal((await success.done).status, 'success');
    assert.equal((await failure.done).status, 'model-failure');
    assert.equal(quota.snapshot().available, 1);
    assert.equal(quota.snapshot().history.length, 1);
    assert.equal(quota.snapshot().calls, 2);
  });
}

test('P08 / AC09: separate demo accounts have separate balances', async () => {
  const a = model(1), b = model(1);
  const requestA = a.start(input()), requestB = b.start(input());
  a.finish(requestA.id);
  assert.equal(b.snapshot().reserved, 1);
  b.finish(requestB.id);
  assert.equal((await requestA.done).status, 'success');
  assert.equal((await requestB.done).status, 'success');
  assert.equal(a.snapshot().remaining, 0);
  assert.equal(b.snapshot().remaining, 0);
});

test('P09 / AC10: input and result snapshots cannot be changed by later editing', async () => {
  const quota = model(1), tasks = ['原任务'];
  const request = quota.start(input({ tasks }));
  tasks[0] = '修改后的任务 [fail]';
  quota.finish(request.id);
  assert.equal((await request.done).status, 'success');
  const snapshot = quota.snapshot();
  assert.deepEqual(snapshot.history[0].tasks, ['原任务']);
  snapshot.history[0].tasks[0] = '尝试改写历史';
  assert.deepEqual(quota.snapshot().history[0].tasks, ['原任务']);
});

test('P10 / AC11: invalid demo inputs never reserve or call', async () => {
  const quota = model(3);
  for (const overrides of [{ tasks: [] }, { tasks: [' '] }, { hours: 0 }, { hours: 25 }, { hours: NaN }, { hours: Infinity }]) {
    assert.equal((await quota.start(input(overrides)).done).status, 'invalid');
  }
  assert.equal(quota.snapshot().calls, 0);
  assert.equal(quota.snapshot().available, 3);
});

test('P11 / AC12: lost response is unknown to client despite backend success', async () => {
  const quota = model(1);
  const request = quota.start(input({ outcome: 'response-lost' }));
  quota.finish(request.id);
  assert.equal((await request.done).status, 'unknown');
  assert.equal(quota.snapshot().remaining, 0);
  assert.equal(quota.snapshot().history.length, 1);
  assert.equal(quota.snapshot().calls, 1);
});

test('P12: resetting a demo cancels pending work without leaking old results', async () => {
  const quota = model(1);
  const request = quota.start(input());
  quota.reset(3);
  assert.equal((await request.done).status, 'cancelled');
  assert.equal(quota.finish(request.id), false);
  assert.equal(quota.snapshot().history.length, 0);
  assert.equal(quota.snapshot().available, 3);
});
