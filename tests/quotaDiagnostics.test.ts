import { expect, test } from 'vitest';
import { safeErrorFields } from '../src/demo-ai-app/quotaDiagnostics';

test('preserves Prisma and SQLSTATE identifiers without private error payloads', () => {
  const error = Object.assign(new Error('postgresql://user:secret@host/db'), {
    name: 'PrismaClientKnownRequestError', code: 'P2010',
    meta: { code: '23505', message: 'session-token', query: 'private task' },
  });
  expect(safeErrorFields(error)).toEqual({ errorName: 'PrismaClientKnownRequestError', prismaCode: 'P2010', sqlState: '23505' });
});
test('initialization errorCode is retained', () => {
  expect(safeErrorFields({ name: 'PrismaClientInitializationError', errorCode: 'P1001' }))
    .toEqual({ errorName: 'PrismaClientInitializationError', prismaCode: 'P1001' });
});
test('nested database code is retained without serializing cause', () => {
  expect(safeErrorFields({ name: 'Error', cause: { code: '40P01', message: 'private SQL' } }))
    .toEqual({ errorName: 'Error', sqlState: '40P01' });
});
test('arbitrary strings and names are not logged', () => {
  expect(safeErrorFields('secret-token')).toEqual({ errorName: 'UnknownError' });
  expect(safeErrorFields({ name: 'private-task-text', code: 'private-password' })).toEqual({ errorName: 'UnknownError' });
});
test('throwing getters cannot break failure recovery', () => {
  expect(safeErrorFields({ get name() { throw new Error('private'); } })).toEqual({ errorName: 'UnknownError' });
});
