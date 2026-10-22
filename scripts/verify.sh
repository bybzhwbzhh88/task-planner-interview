#!/usr/bin/env bash
set -euo pipefail

: "${TEST_DATABASE_URL:?Set TEST_DATABASE_URL to a separate PostgreSQL test database}"
if [[ -n "${DATABASE_URL:-}" && "$DATABASE_URL" == "$TEST_DATABASE_URL" ]]; then
  echo "The test database must differ from DATABASE_URL." >&2
  exit 1
fi

wasp compile
npx tsc --project tsconfig.src.json --noEmit
npx tsc --project tsconfig.wasp.json --noEmit
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy --schema schema.prisma
npm run test:quota -- --reporter=verbose

for round in 1 2 3; do
  echo "Concurrency round $round/3"
  npm run test:quota -- --reporter=verbose -t 'A4 |A5 |A6 '
done
