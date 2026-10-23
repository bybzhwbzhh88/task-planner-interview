#!/usr/bin/env bash
set -euo pipefail

# A dedicated DB is mandatory; never silently reuse a developer's normal DB.
: "${TEST_DATABASE_URL:?Set TEST_DATABASE_URL to an isolated PostgreSQL database ending in _test}"
node --input-type=module -e '
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.pathname.endsWith("_test")) {
    throw new Error("Expected a PostgreSQL test database with a name ending in _test");
  }
'
export DATABASE_URL="$TEST_DATABASE_URL"

wasp compile
# Use the Wasp-generated schema, which also contains the auth models.
npx prisma migrate deploy --schema .wasp/out/db/schema.prisma
npm run typecheck
npm run test:quota
