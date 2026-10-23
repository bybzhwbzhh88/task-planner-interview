import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMockSchedule } from '../src/demo-ai-app/mockAi.ts';

// The real local provider is imported directly; no external API is used.
test('mock provider: successful call emits started + succeeded once', async () => {
  const logs = [];
  const original = console.info;
  console.info = message => { logs.push(JSON.parse(message)); };
  try {
    const result = await generateMockSchedule([{ description: '写计划', time: '1' }], 8);
    assert.equal(result.tasks.length, 1);
    assert.equal(logs.length, 2);
    assert.equal(logs[0].event, 'mock-ai.started');
    assert.equal(logs[1].event, 'mock-ai.succeeded');
    assert.equal(logs[0].callId, logs[1].callId);
  } finally {
    console.info = original;
  }
});

test('mock provider: [fail] emits started + failed and rejects', async () => {
  const logs = [];
  const original = console.info;
  console.info = message => { logs.push(JSON.parse(message)); };
  try {
    await assert.rejects(
      () => generateMockSchedule([{ description: '[fail]', time: '1' }], 8),
      /Mock provider explicitly rejected/,
    );
    assert.equal(logs.length, 2);
    assert.equal(logs[0].event, 'mock-ai.started');
    assert.equal(logs[1].event, 'mock-ai.failed');
    assert.equal(logs[0].callId, logs[1].callId);
  } finally {
    console.info = original;
  }
});
