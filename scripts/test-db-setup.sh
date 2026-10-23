#!/usr/bin/env bash
# Prepares a disposable test database for the quota tests (SPEC.md §7).
#
# Requires the local Docker dev database from `wasp start db` to be running.
# Discovers its container, credentials and host port, then drops and
# recreates the test database so every run starts from the migrated baseline.
# Writes the connection URL to .env.test for the vitest setup to pick up.
set -euo pipefail

TEST_DB_NAME="taskplanner_test"

CONTAINER="$(docker ps --filter "name=wasp-dev-db" --format "{{.Names}}" | head -n 1)"
if [ -z "$CONTAINER" ]; then
  echo "error: no running 'wasp-dev-db' container found. Start it with: wasp start db" >&2
  exit 1
fi

DB_USER="$(docker exec "$CONTAINER" printenv POSTGRES_USER)"
DB_PASS="$(docker exec "$CONTAINER" printenv POSTGRES_PASSWORD)"
HOST_PORT="$(docker port "$CONTAINER" 5432/tcp | head -n 1 | sed 's/.*://')"

if [ -z "$DB_USER" ] || [ -z "$DB_PASS" ] || [ -z "$HOST_PORT" ]; then
  echo "error: could not discover the dev DB credentials or host port from container '$CONTAINER'" >&2
  exit 1
fi

TEST_DATABASE_URL="postgres://${DB_USER}:${DB_PASS}@localhost:${HOST_PORT}/${TEST_DB_NAME}"

# Recreate from scratch on every run: fully deterministic, no leftovers.
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS \"${TEST_DB_NAME}\" WITH (FORCE)" >/dev/null
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres \
  -c "CREATE DATABASE \"${TEST_DB_NAME}\"" >/dev/null

# Apply project migrations in name order (they are timestamped).
for migration in migrations/*/migration.sql; do
  echo "applying $migration"
  docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$TEST_DB_NAME" \
    -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done

printf 'TEST_DATABASE_URL=%s\n' "$TEST_DATABASE_URL" > .env.test
echo "test database ready: '${TEST_DB_NAME}' (fresh, migrations applied)"
