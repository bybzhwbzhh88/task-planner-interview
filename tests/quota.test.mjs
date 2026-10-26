import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runGeneration } from '../src/demo-ai-app/quota.ts';
import { generateMockSchedule } from '../src/demo-ai-app/mockAi.ts';

// In-memory adapter tests control flow and rollback, NOT PostgreSQL locking.
function memory(credits) {
  let results = [], queue = Promise.resolve();
  return {
    state: () => ({ credits, results: results.length }),
    transaction(fn, failSave = false) {
      const next = queue.then(async () => {
        const before = credits, saved = results.length;
        try {
          return await fn({
            user: { updateMany: async ({ where, data }) => {
              if (credits <= where.credits.gt) return { count: 0 };
              credits -= data.credits.decrement;
              return { count: 1 };
            } },
            planResult: { create: async ({ data }) => {
              if (failSave) throw new Error('save failed');
              results.push(data);
            } },
          });
        } catch (error) { credits = before; results.length = saved; throw error; }
      });
      queue = next.catch(() => {});
      return next;
    },
  };
}
const task = [{ description: '写报告', time: '1' }];
for (const [credits, count, expected] of [[3, 1, 1], [0, 1, 0], [1, 10, 1], [3, 10, 3]]) {
  test(`credits=${credits}, requests=${count}`, async () => {
    const db = memory(credits);
    let started = 0;
    const outcomes = await Promise.allSettled(Array.from({ length: count }, () => db.transaction(tx =>
      runGeneration(tx, 'u', () => { started++; return generateMockSchedule(task, 8); }))));
    assert.equal(started, expected);
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, expected);
    for (const x of outcomes.filter(x => x.status === 'rejected')) assert.equal(x.reason.statusCode, 402);
    assert.deepEqual(db.state(), { credits: credits - expected, results: expected });
  });
}
test('provider failure rolls back; corrected retry succeeds', async () => {
  const db = memory(1);
  await assert.rejects(db.transaction(tx => runGeneration(tx, 'u', () => generateMockSchedule([{ description: '[fail]', time: '1' }], 8))), { statusCode: 502 });
  assert.deepEqual(db.state(), { credits: 1, results: 0 });
  await db.transaction(tx => runGeneration(tx, 'u', () => generateMockSchedule(task, 8)));
  assert.deepEqual(db.state(), { credits: 0, results: 1 });
});
test('save failure rolls back deduction', async () => {
  const db = memory(1);
  await assert.rejects(db.transaction(tx => runGeneration(tx, 'u', () => generateMockSchedule(task, 8)), true), /save failed/);
  assert.deepEqual(db.state(), { credits: 1, results: 0 });
});
