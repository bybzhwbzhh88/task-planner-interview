import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { runGeneration } from '../src/demo-ai-app/quota.ts';
import { generateMockSchedule } from '../src/demo-ai-app/mockAi.ts';

// Only use an isolated test database. Each case creates and cleans its own user.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to an isolated, migrated PostgreSQL database');
const db = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
const tasks = [{ description: 'integration task', time: '1' }];
async function scenario(credits, requests, fail = false, failSave = false) {
  const user = await db.user.create({ data: { credits } });
  let calls = 0;
  try {
    const outcomes = await Promise.allSettled(Array.from({ length: requests }, () => db.$transaction(async tx => {
      const adapter = failSave ? { user: tx.user, planResult: { create: async () => { throw new Error('save failed'); } } } : tx;
      return runGeneration(adapter, user.id, () => {
        calls++;
        return generateMockSchedule(fail ? [{ description: '[fail]', time: '1' }] : tasks, 8);
      });
    }, { maxWait: 10_000, timeout: 15_000 })));
    const success = fail || failSave ? 0 : Math.min(credits, requests);
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, success);
    assert.equal(calls, fail || failSave ? requests : success);
    for (const outcome of outcomes.filter(x => x.status === 'rejected')) {
      if (failSave) assert.match(outcome.reason.message, /save failed/);
      else assert.equal(outcome.reason.statusCode, fail ? 502 : 402);
    }
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: user.id } })).credits, credits - success);
    assert.equal(await db.planResult.count({ where: { userId: user.id } }), success);
    console.log(JSON.stringify({ credits, requests, calls, success, remaining: credits - success }));
  } finally {
    await db.planResult.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  }
}
test('PostgreSQL quota integration', async t => {
  try {
    await t.test('A1 success', () => scenario(3, 1));
    await t.test('A2 exhausted', () => scenario(0, 1));
    await t.test('A3 provider failure', () => scenario(1, 1, true));
    await t.test('A4 one credit, ten concurrent transactions', () => scenario(1, 10));
    await t.test('A5 three credits, ten concurrent transactions', () => scenario(3, 10));
    await t.test('A6 save rollback', () => scenario(1, 1, false, true));
  } finally { await db.$disconnect(); }
});
