#!/usr/bin/env bash
set -euo pipefail
test -f .env.server || { echo "Configure .env.server first" >&2; exit 1; }
set -a
source .env.server
set +a
npm run db-migrate-prod --workspace @wasp.sh/generated-server
exec wasp start
