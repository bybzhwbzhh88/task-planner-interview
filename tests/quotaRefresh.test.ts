import { expect, test, vi } from 'vitest';
import { refreshQuotaResults } from '../src/demo-ai-app/quotaRefresh';

const schedule = { tasks: [], taskItems: [] };
const quota = { data: { availableCredits: 1, processingCount: 0 } };
const saved = { data: [{ content: JSON.stringify(schedule) }] };
function callbacks() { return { onResult: vi.fn(), onMessage: vi.fn() }; }

test('successful refresh replaces the previous unknown/failure message and recovers the result', async () => {
  let message = '生成结果暂未确认';
  const onResult = vi.fn();
  await refreshQuotaResults({ loadQuota: async () => quota, loadResults: async () => saved, onResult, onMessage: value => { message = value; } });
  expect(message).toContain('已刷新额度与最近成功结果');
  expect(message).not.toContain('暂未确认');
  expect(onResult).toHaveBeenCalledWith(schedule);
});
test('successful empty refresh explains absence and clears old result', async () => {
  const cb = callbacks();
  await refreshQuotaResults({ loadQuota: async () => quota, loadResults: async () => ({ data: [] }), ...cb });
  expect(cb.onResult).toHaveBeenCalledWith(null);
  expect(cb.onMessage.mock.calls[0][0]).toContain('目前没有已保存的日程');
});
test('cached results accompanying an error are not advertised as a successful refresh', async () => {
  const cb = callbacks();
  await refreshQuotaResults({ loadQuota: async () => quota, loadResults: async () => ({ ...saved, error: new Error('offline') }), ...cb });
  expect(cb.onResult).not.toHaveBeenCalled();
  expect(cb.onMessage.mock.calls[0][0]).toContain('最近结果读取失败');
});
test('partial success recovers result without claiming quota is current', async () => {
  const cb = callbacks();
  await refreshQuotaResults({ loadQuota: async () => ({ ...quota, error: new Error('offline') }), loadResults: async () => saved, ...cb });
  expect(cb.onResult).toHaveBeenCalledWith(schedule);
  expect(cb.onMessage.mock.calls[0][0]).toContain('但额度读取失败');
});
test('malformed saved JSON keeps the existing display and explains the failure', async () => {
  const cb = callbacks();
  await refreshQuotaResults({ loadQuota: async () => quota, loadResults: async () => ({ data: [{ content: '{broken' }] }), ...cb });
  expect(cb.onResult).not.toHaveBeenCalled();
  expect(cb.onMessage.mock.calls[0][0]).toContain('结果无法读取');
});
test('rejected reads become an explicit refresh failure', async () => {
  const cb = callbacks();
  await refreshQuotaResults({ loadQuota: async () => { throw new Error('offline'); }, loadResults: async () => { throw new Error('offline'); }, ...cb });
  expect(cb.onMessage.mock.calls[0][0]).toContain('额度与最近结果读取失败');
  expect(cb.onResult).not.toHaveBeenCalled();
});
test('the old message remains until both reads have completed', async () => {
  const cb = callbacks();
  let finish!: (value: typeof saved) => void;
  const pending = refreshQuotaResults({ loadQuota: async () => quota, loadResults: () => new Promise(resolve => { finish = resolve; }), ...cb });
  expect(cb.onMessage).not.toHaveBeenCalled();
  finish(saved);
  await pending;
  expect(cb.onMessage).toHaveBeenCalledOnce();
});
