import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { generateWithQuota, getQuotaSnapshot, refundRequest, saveSuccess, type Faults, type Provider } from '../src/demo-ai-app/quotaService';
import { generateMockSchedule } from '../src/demo-ai-app/mockAi';

const db = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
const users: string[] = [];
const schedule = { tasks: [], taskItems: [] };
const success: Provider = async () => schedule;
const failure: Provider = async () => { throw new Error('Explicit test provider failure'); };
const fail = () => { throw new Error('Injected fault'); };
async function account(credits: number, tasks = true) {
  const user = await db.user.create({ data: { credits, ...(tasks ? { tasks: { create: { description: 'test task' } } } : {}) } });
  users.push(user.id);
  return user.id;
}
async function snapshot(id: string) {
  return { ...(await getQuotaSnapshot(db, id)), results: await db.planResult.count({ where: { userId: id } }) };
}
function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
beforeAll(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterAll(async () => {
  await db.planResult.deleteMany({ where: { userId: { in: users } } });
  await db.generationRequest.deleteMany({ where: { userId: { in: users } } });
  await db.task.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
  vi.restoreAllMocks();
});
describe.sequential('Quota acceptance against real PostgreSQL', () => {
  test('A01 successful generation consumes exactly one', async () => {
    const id = await account(3);
    const provider = vi.fn(success);
    await generateWithQuota(db, id, { hours: 8 }, provider);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await snapshot(id)).toEqual({ availableCredits: 2, processingCount: 0, results: 1 });
    expect((await db.generationRequest.findFirstOrThrow({ where: { userId: id } })).status).toBe('SUCCEEDED');
  });
  test('A02 zero balance never invokes provider', async () => {
    const id = await account(0); const provider = vi.fn(success);
    await expect(generateWithQuota(db, id, { hours: 8 }, provider)).rejects.toMatchObject({ statusCode: 402, code: 'QUOTA_EXHAUSTED' });
    expect(provider).not.toHaveBeenCalled();
    expect(await snapshot(id)).toEqual({ availableCredits: 0, processingCount: 0, results: 0 });
    expect(await db.generationRequest.count({ where: { userId: id } })).toBe(0);
  });
  test('A03/A04 actual mock failure restores credit; retry succeeds', async () => {
    const id = await account(1);
    await db.task.updateMany({ where: { userId: id }, data: { description: '[fail]' } });
    await expect(generateWithQuota(db, id, { hours: 8 }, generateMockSchedule)).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(await snapshot(id)).toEqual({ availableCredits: 1, processingCount: 0, results: 0 });
    await db.task.updateMany({ where: { userId: id }, data: { description: 'normal task' } });
    await generateWithQuota(db, id, { hours: 8 }, generateMockSchedule);
    expect(await snapshot(id)).toEqual({ availableCredits: 0, processingCount: 0, results: 1 });
  });
  for (const credits of [1, 3]) test(`A0${credits === 1 ? 5 : 6} 10 parallel requests / ${credits} credits / 20 rounds`, async () => {
    for (let round = 0; round < 20; round++) {
      const id = await account(credits); const provider = vi.fn(success);
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => generateWithQuota(db, id, { hours: 8 }, provider)));
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(credits);
      const rejected = results.filter(r => r.status === 'rejected');
      expect(rejected).toHaveLength(10 - credits);
      for (const result of rejected) if (result.status === 'rejected') expect(result.reason.code).toBe('QUOTA_EXHAUSTED');
      expect(provider).toHaveBeenCalledTimes(credits);
      expect(await snapshot(id)).toEqual({ availableCredits: 0, processingCount: 0, results: credits });
      expect(await db.generationRequest.count({ where: { userId: id, status: 'SUCCEEDED' } })).toBe(credits);
    }
  });
  test('A07 in-flight reservation rejects another call, then failure permits retry', async () => {
    const id = await account(1); const entered = gate(); const release = gate();
    const provider = vi.fn(async () => { entered.open(); await release.promise; return failure([], 8, 'test'); });
    const first = generateWithQuota(db, id, { hours: 8 }, provider).catch(e => e);
    await entered.promise;
    expect(await getQuotaSnapshot(db, id)).toEqual({ availableCredits: 0, processingCount: 1 });
    try { await expect(generateWithQuota(db, id, { hours: 8 }, provider)).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' }); }
    finally { release.open(); }
    expect((await first).code).toBe('PROVIDER_FAILED');
    await generateWithQuota(db, id, { hours: 8 }, success);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await snapshot(id)).toEqual({ availableCredits: 0, processingCount: 0, results: 1 });
  });
  test('A08 save rollback refunds only once, failed request cannot succeed', async () => {
    const id = await account(1);
    await expect(generateWithQuota(db, id, { hours: 8 }, success, { beforeSave: fail })).rejects.toMatchObject({ code: 'RESULT_SAVE_FAILED' });
    const request = await db.generationRequest.findFirstOrThrow({ where: { userId: id } });
    await Promise.all(Array.from({ length: 10 }, () => refundRequest(db, id, request.id, 'RESULT_SAVE_FAILED')));
    await expect(saveSuccess(db, id, request.id, schedule)).rejects.toThrow();
    expect(await snapshot(id)).toEqual({ availableCredits: 1, processingCount: 0, results: 0 });
  });
  test('A09 committed success survives lost acknowledgment and duplicate settlement', async () => {
    const id = await account(1);
    expect(await generateWithQuota(db, id, { hours: 8 }, success, { afterSaveCommit: fail })).toEqual(schedule);
    const request = await db.generationRequest.findFirstOrThrow({ where: { userId: id } });
    await saveSuccess(db, id, request.id, schedule);
    await refundRequest(db, id, request.id, 'RESULT_SAVE_FAILED');
    expect(await snapshot(id)).toEqual({ availableCredits: 0, processingCount: 0, results: 1 });
  });
  for (const fault of ['beforeRefund', 'beforeRecoveryRead'] as const) test(`A10 ${fault} failure stays uncertain`, async () => {
    const id = await account(1);
    await expect(generateWithQuota(db, id, { hours: 8 }, failure, { [fault]: fail } satisfies Faults)).rejects.toMatchObject({ statusCode: 503, code: 'GENERATION_UNCERTAIN', requestId: expect.any(String) });
    expect(await snapshot(id)).toEqual({ availableCredits: 0, processingCount: 1, results: 0 });
  });
  test('ambiguous reservation is released without invoking provider', async () => {
    const id = await account(1); const provider = vi.fn(success);
    await expect(generateWithQuota(db, id, { hours: 8 }, provider, { afterReserveCommit: fail })).rejects.toMatchObject({ code: 'RESERVATION_FAILED' });
    expect(provider).not.toHaveBeenCalled();
    expect(await snapshot(id)).toEqual({ availableCredits: 1, processingCount: 0, results: 0 });
  });
  test('A11 invalid requests never consume or invoke provider', async () => {
    const id = await account(1); const empty = await account(1, false); const provider = vi.fn(success);
    await expect(generateWithQuota(db, undefined, { hours: 8 }, provider)).rejects.toMatchObject({ statusCode: 401 });
    for (const hours of [0, 25, 1.2, NaN, Infinity, '8']) await expect(generateWithQuota(db, id, { hours }, provider)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(generateWithQuota(db, empty, { hours: 8 }, provider)).rejects.toMatchObject({ code: 'NO_TASKS' });
    expect(provider).not.toHaveBeenCalled();
    expect((await snapshot(id)).availableCredits).toBe(1);
  });
  test('A12 accounts remain isolated', async () => {
    const a = await account(1), b = await account(1);
    await Promise.all([generateWithQuota(db, a, { hours: 8 }, success), generateWithQuota(db, b, { hours: 8 }, success)]);
    expect(await snapshot(a)).toEqual({ availableCredits: 0, processingCount: 0, results: 1 });
    expect(await snapshot(b)).toEqual({ availableCredits: 0, processingCount: 0, results: 1 });
  });
  test('database constraint rejects negative credit writes', async () => {
    const id = await account(1);
    await expect(db.user.update({ where: { id }, data: { credits: -1 } })).rejects.toThrow();
    expect((await snapshot(id)).availableCredits).toBe(1);
  });
  test('migration keeps legacy results without request linkage', async () => {
    const id = await account(1);
    const result = await db.planResult.create({ data: { userId: id, content: JSON.stringify(schedule) } });
    expect(result.generationRequestId).toBeNull();
  });
});

test('actual mock logs count invocations and correlate request IDs', async () => {
  const log = vi.mocked(console.info);
  const id = await account(0);
  log.mockClear();
  await expect(generateWithQuota(db, id, { hours: 8 }, generateMockSchedule)).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' });
  expect(log.mock.calls.filter(([value]) => String(value).includes('mock-ai.started'))).toHaveLength(0);
  await db.user.update({ where: { id }, data: { credits: 1 } });
  await generateWithQuota(db, id, { hours: 8 }, generateMockSchedule);
  const successEvents = log.mock.calls.map(([value]) => JSON.parse(String(value)));
  const start = successEvents.filter(e => e.event === 'mock-ai.started');
  expect(start).toHaveLength(1);
  expect(successEvents.find(e => e.event === 'mock-ai.succeeded')).toMatchObject({ callId: start[0].callId, requestId: start[0].requestId });
  expect(successEvents.find(e => e.event === 'generation.succeeded')).toMatchObject({ requestId: start[0].requestId });
  await db.user.update({ where: { id }, data: { credits: 1 } });
  await db.task.updateMany({ where: { userId: id }, data: { description: '[fail]' } });
  log.mockClear();
  await expect(generateWithQuota(db, id, { hours: 8 }, generateMockSchedule)).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  const failedEvents = log.mock.calls.map(([value]) => JSON.parse(String(value)));
  const failedStart = failedEvents.filter(e => e.event === 'mock-ai.started');
  expect(failedStart).toHaveLength(1);
  expect(failedEvents.find(e => e.event === 'mock-ai.failed')).toMatchObject({ callId: failedStart[0].callId, requestId: failedStart[0].requestId });
  expect((await getQuotaSnapshot(db, id)).availableCredits).toBe(1);
});

test('save diagnostics preserve safe cause identifiers and correlate the refunded request', async () => {
  const id = await account(1);
  const error = Object.assign(new Error('postgresql://private:secret@host/db session-token'), { name: 'PrismaClientKnownRequestError', code: 'P2010', meta: { code: '23505', message: 'private task' } });
  const log = vi.mocked(console.error);
  log.mockClear();
  await expect(generateWithQuota(db, id, { hours: 8 }, success, { beforeSave: () => { throw error; } })).rejects.toMatchObject({ code: 'RESULT_SAVE_FAILED' });
  const request = await db.generationRequest.findFirstOrThrow({ where: { userId: id } });
  const entry = log.mock.calls.map(([value]) => JSON.parse(String(value))).find(value => value.phase === 'save');
  expect(entry).toMatchObject({ event: 'generation.error', phase: 'save', requestId: request.id, userId: id, code: 'RESULT_SAVE_FAILED', prismaCode: 'P2010', sqlState: '23505', errorName: 'PrismaClientKnownRequestError' });
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|session-token|private task|postgresql/);
  expect(await snapshot(id)).toEqual({ availableCredits: 1, processingCount: 0, results: 0 });
});
