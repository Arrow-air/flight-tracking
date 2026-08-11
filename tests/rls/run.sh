#!/usr/bin/env bash
# RLS gate runner (critic-owned). Fresh DB, then the full matrix.
# Usage: tests/rls/run.sh [--no-reset]
# Exit 0 = every test passed; non-zero = failures (psql raises at end of matrix).
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DB_CONTAINER="supabase_db_flight-tracking"

if [[ "${1:-}" != "--no-reset" ]]; then
  echo "== supabase db reset (fresh DB) =="
  (cd "$REPO" && /opt/homebrew/bin/supabase db reset) || { echo "db reset FAILED"; exit 2; }
fi

echo "== RLS matrix =="
docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -f - < "$REPO/tests/rls/rls_matrix.sql"
rc=$?
echo "== matrix exit code: $rc =="
exit $rc
