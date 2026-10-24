import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

if (existsSync('.env.server')) loadEnvFile('.env.server');
const base = new URL(process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3001');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Smoke testing is restricted to the local development server.');
const db = new PrismaClient();
const username = `quota_${randomUUID().replaceAll('-', '')}`;
const password = randomUUID();
let userId;
let token;
async function post(path, body, authenticated = true) {
  const response = await fetch(new URL(path, base), {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated && token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json() };
}
const operation = (name, args = {}, authenticated = true) => post(`/operations/${name}`, { json: args }, authenticated);
try {
  assert.equal((await operation('get-quota', {}, false)).status, 401);
  assert.equal((await post('/auth/username/signup', { username, password }, false)).status, 200);
  const identity = await db.authIdentity.findUniqueOrThrow({ where: { providerName_providerUserId: { providerName: 'username', providerUserId: username } } });
  userId = (await db.auth.findUniqueOrThrow({ where: { id: identity.authId } })).userId;
  const login = await post('/auth/username/login', { username, password }, false);
  assert.equal(login.status, 200); token = login.body.sessionId; assert.ok(token);
  const task = await operation('create-task', { description: 'HTTP smoke task' });
  assert.equal(task.status, 200);
  assert.equal((await operation('generate-plan', { hours: 8 })).status, 200);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: userId } })).credits, 2);
  console.log('A01 HTTP success: saved=1, credits=2');
  await db.user.update({ where: { id: userId }, data: { credits: 0 } });
  const denied = await operation('generate-plan', { hours: 8 });
  assert.equal(denied.status, 402); assert.equal(denied.body.data.code, 'QUOTA_EXHAUSTED');
  assert.equal(await db.planResult.count({ where: { userId } }), 1);
  console.log('A02 HTTP zero credit: 402 / QUOTA_EXHAUSTED, no new result');
  await db.user.update({ where: { id: userId }, data: { credits: 1 } });
  await db.task.updateMany({ where: { userId }, data: { description: '[fail]' } });
  const failed = await operation('generate-plan', { hours: 8 });
  assert.equal(failed.status, 502); assert.equal(failed.body.data.code, 'PROVIDER_FAILED');
  assert.ok(failed.body.data.requestId);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: userId } })).credits, 1);
  console.log('A03 HTTP mock failure: 502 / PROVIDER_FAILED, credits restored to 1');
  await db.task.updateMany({ where: { userId }, data: { description: 'normal task' } });
  const parallel = await Promise.all(Array.from({ length: 10 }, () => operation('generate-plan', { hours: 8 })));
  assert.equal(parallel.filter(r => r.status === 200).length, 1);
  assert.equal(parallel.filter(r => r.status === 402 && r.body.data.code === 'QUOTA_EXHAUSTED').length, 9);
  assert.equal(await db.planResult.count({ where: { userId } }), 2);
  const quota = await operation('get-quota');
  assert.equal(quota.status, 200);
  assert.deepEqual(quota.body.json, { availableCredits: 0, processingCount: 0 });
  console.log('A04/A05 HTTP retry and parallel: success=1, denied=9, final credits=0');
  const invalid = await operation('generate-plan', { hours: 25 });
  assert.equal(invalid.status, 400); assert.equal(invalid.body.data.code, 'INVALID_INPUT');
  const result = await operation('get-plan-results');
  assert.equal(result.status, 200); assert.equal(result.body.json.length, 2);
  console.log('A11/A13 HTTP validation and result recovery: 400 / INVALID_INPUT; refresh reads 2 saved results without consuming');
  await db.user.update({ where: { id: userId }, data: { credits: 1 } });
  const controller = new AbortController();
  const lostResponse = fetch(new URL('/operations/generate-plan', base), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ json: { hours: 8 } }), signal: controller.signal,
  }).catch(() => undefined);
  let inFlight;
  for (let attempt = 0; attempt < 100; attempt++) {
    inFlight = await db.generationRequest.findFirst({ where: { userId, status: 'PROCESSING' } });
    if (inFlight) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(inFlight, 'Must observe server reservation before dropping the client response');
  controller.abort();
  await lostResponse;
  let completed;
  for (let attempt = 0; attempt < 100; attempt++) {
    completed = await db.generationRequest.findUniqueOrThrow({ where: { id: inFlight.id } });
    if (completed.status !== 'PROCESSING') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(completed.status, 'SUCCEEDED');
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: userId } })).credits, 0);
  assert.equal((await operation('get-plan-results')).body.json.length, 3);
  console.log('A13 dropped client response: server completed once; refresh recovered saved result; no extra consumption');
  console.log('HTTP smoke passed; temporary account is removed in cleanup.');
} finally {
  if (userId) {
    await db.planResult.deleteMany({ where: { userId } });
    await db.generationRequest.deleteMany({ where: { userId } });
    await db.task.deleteMany({ where: { userId } });
    await db.auth.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } });
  }
  await db.$disconnect();
}
