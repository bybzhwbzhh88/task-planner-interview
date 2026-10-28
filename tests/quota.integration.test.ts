import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { prisma } from 'wasp/server';
import { generatePlan } from '../src/demo-ai-app/operations';

// Keep this suite away from the interactive preview database.
if (process.env.QUOTA_TEST_RUN !== '1'
  || !/^\/planner_quota_test_[a-f0-9]{12}$/.test(new URL(process.env.DATABASE_URL!).pathname)) {
  throw new Error('请通过 npm run test:quota 创建隔离数据库后运行测试。');
}

type Context = Parameters<typeof generatePlan>[1];
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  log = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await prisma.$disconnect(); });

async function fixture(credits: number, description = '写报告') {
  const user = await prisma.user.create({ data: { credits } });
  await prisma.task.create({ data: { userId: user.id, description } });
  return {
    user: { ...user },
    entities: { User: prisma.user, Task: prisma.task, PlanResult: prisma.planResult },
  } as unknown as Context;
}

function events(): string[] {
  return log.mock.calls.flatMap(([value]) => {
    try { return [JSON.parse(String(value)).event]; }
    catch { return []; }
  });
}

function statuses(results: PromiseSettledResult<unknown>[]) {
  return results.map(result => result.status === 'fulfilled'
    ? 200 : (result.reason.statusCode ?? 'unclassified-error'));
}

async function observe(label: string, context: Context, results: PromiseSettledResult<unknown>[]) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: context.user!.id } });
  const observation = {
    statuses: statuses(results),
    credits: user.credits,
    plans: await prisma.planResult.count({ where: { userId: user.id } }),
    calls: events().filter(event => event === 'mock-ai.started').length,
  };
  console.log(`${label} ${JSON.stringify(observation)}`);
  return observation;
}

const generate = (context: Context) => generatePlan({ hours: 8 }, context);

describe('额度规则：真实 PostgreSQL + 实际 generatePlan + 实际本地模拟接口', () => {
  test('A1 成功保存一份日程并扣一次', async () => {
    const context = await fixture(3);
    const results = await Promise.allSettled([generate(context)]);
    expect(await observe('A1', context, results))
      .toEqual({ statuses: [200], credits: 2, plans: 1, calls: 1 });
    const plan = await prisma.planResult.findFirstOrThrow({ where: { userId: context.user!.id } });
    expect(JSON.parse(plan.content)).toEqual((results[0] as PromiseFulfilledResult<unknown>).value);
  });

  test.each(['写报告', '[fail]'])('A2 零额度不调用模型：%s', async description => {
    const context = await fixture(0, description);
    const results = await Promise.allSettled([generate(context)]);
    expect(await observe('A2', context, results))
      .toEqual({ statuses: [402], credits: 0, plans: 0, calls: 0 });
  });

  test('A3 明确失败不扣次，修改任务后可重试', async () => {
    const context = await fixture(1, '[fail]');
    const failed = await Promise.allSettled([generate(context)]);
    expect(await observe('A3-failure', context, failed))
      .toEqual({ statuses: [502], credits: 1, plans: 0, calls: 1 });
    await prisma.task.updateMany({ where: { userId: context.user!.id }, data: { description: '写报告' } });
    const retried = await Promise.allSettled([generate(context)]);
    expect(await observe('A3-retry', context, retried))
      .toEqual({ statuses: [200], credits: 0, plans: 1, calls: 2 });
  });

  test.each([[1, 'A4'], [3, 'A5']] as const)('%i 次额度承受五个并发请求', async (credits, label) => {
    const context = await fixture(credits);
    // Each request starts with the same old user snapshot, like simultaneous HTTP requests.
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => generate(context)));
    const observed = await observe(label, context, results);
    expect(observed.statuses.filter(status => status === 200)).toHaveLength(credits);
    expect(observed.statuses.filter(status => status === 402)).toHaveLength(5 - credits);
    expect(observed).toMatchObject({ credits: 0, plans: credits, calls: credits });
  });

  test('A6 忽略过期的请求额度快照', async () => {
    const context = await fixture(3);
    await prisma.user.update({ where: { id: context.user!.id }, data: { credits: 0 } });
    const results = await Promise.allSettled([generate(context)]);
    expect(await observe('A6', context, results))
      .toEqual({ statuses: [402], credits: 0, plans: 0, calls: 0 });
  });

  test('A7 不同账号可以同时调用模型', async () => {
    const a = await fixture(1);
    const b = await fixture(1);
    const results = await Promise.allSettled([generate(a), generate(b)]);
    expect(await observe('A7-a', a, [results[0]]))
      .toEqual({ statuses: [200], credits: 0, plans: 1, calls: 2 });
    expect(await observe('A7-b', b, [results[1]]))
      .toEqual({ statuses: [200], credits: 0, plans: 1, calls: 2 });
    expect(events().slice(0, 2)).toEqual(['mock-ai.started', 'mock-ai.started']);
  });

  test('A8 未登录不调用模型', async () => {
    const context = await fixture(1);
    const results = await Promise.allSettled([generate({ ...context, user: undefined })]);
    expect(await observe('A8-auth', context, results))
      .toEqual({ statuses: [401], credits: 1, plans: 0, calls: 0 });
  });

  test('A9 并发失败不扣次，失败会释放锁', async () => {
    const context = await fixture(1, '[fail]');
    const results = await Promise.allSettled([generate(context), generate(context)]);
    expect(await observe('A9', context, results))
      .toEqual({ statuses: [502, 502], credits: 1, plans: 0, calls: 2 });
  });

  test('A11 保存后扣减失败时，结果和额度一起回滚', async () => {
    const context = await fixture(1);
    const id = context.user!.id;
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    // Fault injection exists only in this disposable test database and user.
    // The result insert runs first; reject the subsequent debit to prove rollback.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "User" ADD CONSTRAINT "quota_test_reject_debit"
       CHECK ("id" <> '${id}' OR "credits" >= 1)`,
    );
    try {
      const results = await Promise.allSettled([generate(context)]);
      expect(await observe('A11-rollback', context, results))
        .toEqual({ statuses: [503], credits: 1, plans: 0, calls: 1 });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "User" DROP CONSTRAINT "quota_test_reject_debit"');
    }
    const results = await Promise.allSettled([generate(context)]);
    expect(await observe('A11-retry', context, results))
      .toEqual({ statuses: [200], credits: 0, plans: 1, calls: 2 });
  });
});
