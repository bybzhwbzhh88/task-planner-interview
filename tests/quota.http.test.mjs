import assert from "node:assert/strict";
import test from "node:test";

const server = process.env.TEST_SERVER_URL ?? "http://localhost:3001";

for (const operation of ["generate-plan", "get-credits"]) {
  test(`A8 HTTP: unauthenticated ${operation} returns 401`, async () => {
    const response = await fetch(`${server}/operations/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: { hours: 8 } }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 401);
    await response.body?.cancel();
  });
}
