/**
 * Real PostgreSQL concurrency proof for the same conditional UPDATE used by
 * Prisma's updateMany(where: { credits: { gt: 0 } }, decrement: 1).
 *
 * Requirements: `psql` installed, isolated test database with Wasp migrations,
 * and QUOTA_TEST_DATABASE_URL set to its connection string. The script inserts
 * and deletes its own ephemeral rows. NEVER run against a production database.
 *
 * This tests the database primitive, not an HTTP/Wasp end-to-end request.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Set QUOTA_TEST_DATABASE_URL to an isolated migrated PostgreSQL test database (not production).');
}

function sql(statement) {
  return new Promise((resolve, reject) => {
    const process = spawn('psql', [
      '--no-psqlrc', '--tuples-only', '--no-align',
      '--set', 'ON_ERROR_STOP=on',
      '--dbname', databaseUrl,
      '--command', statement,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    process.stdout.setEncoding('utf8').on('data', c => { stdout += c; });
    process.stderr.setEncoding('utf8').on('data', c => { stderr += c; });
    process.on('error', reject);
    process.on('close', (code) => {
      if (code !== 0) reject(Error(`psql exit ${code}: ${stderr}`));
      else resolve(stdout.trim());
    });
  });
}

async function verifyConcurrentConditionalUpdate(initial, attempts) {
  const id = randomUUID(); // generated internally; never interpolate user input into SQL
  await sql(`INSERT INTO "User" ("id", "credits") VALUES ('${id}', ${initial})`);
  try {
    const requests = Array.from({ length: attempts }, () => sql(`
      WITH charged AS (
        UPDATE "User"
        SET "credits" = "credits" - 1
        WHERE "id" = '${id}' AND "credits" > 0
        RETURNING 1
      ) SELECT COUNT(*) FROM charged;
    `));
    const results = await Promise.all(requests);
    const affected = results.map(value => Number(value));
    assert.ok(affected.every(v => v === 0 || v === 1), 'each request must affect 0 or 1 row');
    assert.equal(affected.filter(v => v === 1).length, initial);
    const remaining = Number(await sql(`SELECT "credits" FROM "User" WHERE "id"='${id}';`));
    assert.equal(remaining, 0);
    assert.ok(remaining >= 0, 'no overdraft');
  } finally {
    await sql(`DELETE FROM "User" WHERE "id"='${id}';`);
  }
}

test('PostgreSQL: 10 concurrent conditional updates with 1 credit', async () => {
  await verifyConcurrentConditionalUpdate(1, 10);
});

test('PostgreSQL: 50 concurrent conditional updates with 3 credits', async () => {
  await verifyConcurrentConditionalUpdate(3, 50);
});
