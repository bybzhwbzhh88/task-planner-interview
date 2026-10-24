import { expect, test } from 'vitest';
import { quotaFeedback } from '../src/demo-ai-app/quotaFeedback';

test('Wasp 0.25 nested HTTP body preserves explicit failure and request reference', () => {
  expect(quotaFeedback({ statusCode: 502, data: { message: '本次未消耗额度', data: { code: 'PROVIDER_FAILED', requestId: 'request-1' } } }))
    .toEqual({ code: 'PROVIDER_FAILED', requestId: 'request-1', message: '本次未消耗额度' });
});
test('network failures never claim a refund', () => {
  expect(quotaFeedback(new Error('Failed to fetch')).message).toContain('暂未确认');
});
test('uncertain database settlement never claims a refund', () => {
  expect(quotaFeedback({ data: { message: 'internal detail', data: { code: 'GENERATION_UNCERTAIN', requestId: 'request-2' } } }).message).toContain('暂未确认');
});
