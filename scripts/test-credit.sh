#!/usr/bin/env sh
set -eu

: "${TEST_DATABASE_URL:?Set TEST_DATABASE_URL to an isolated PostgreSQL database}"

export DATABASE_URL="$TEST_DATABASE_URL"

npx prisma migrate deploy --schema schema.prisma
npx vitest run tests/credit-billing.integration.test.ts
