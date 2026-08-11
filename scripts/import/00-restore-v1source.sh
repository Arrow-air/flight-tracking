#!/usr/bin/env bash
# 00-restore-v1source.sh — restore the REAL v1 backup dumps into a local
# Docker Postgres container named `v1source`.
#
# Source of truth (RUN-CONTEXT "Import"): the dumps in backups/ — NEVER the
# live hosted project. This script only ever touches the local container.
#
#   backups/v1-public-20260809.dump            public schema (schema + data)
#   backups/v1-auth-storage-data-20260809.dump auth/storage DATA only
#
# The supabase/postgres image ships an OLD auth baseline (no email_confirmed_at
# etc.) and no storage tables (storage-api creates those at runtime), so we
# patch auth.users and create minimal storage tables before the data restore.
#
# Idempotent: if the container already holds a complete restore (marker counts
# match), this is a no-op. Pass --force to destroy and restore from scratch.
#
# Usage: scripts/import/00-restore-v1source.sh [--force]

set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BACKUPS="$REPO/backups"
PUBLIC_DUMP="$BACKUPS/v1-public-20260809.dump"
AUTH_DUMP="$BACKUPS/v1-auth-storage-data-20260809.dump"
CONTAINER=v1source
IMAGE="public.ecr.aws/supabase/postgres:17.6.1.158"   # same image as local stack
PORT=55432
PGBIN=/opt/homebrew/opt/libpq/bin                      # pg_restore 18.x (dump v1.16 needs >= 18)
PSQL="$PGBIN/psql"
PG_RESTORE="$PGBIN/pg_restore"
export PGPASSWORD=postgres
V1PSQL=("$PSQL" -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U postgres -d postgres)
# auth/storage schemas are owned by supabase_admin in this image (same password)
ADMPSQL=("$PSQL" -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U supabase_admin -d postgres)

[ -f "$PUBLIC_DUMP" ] || { echo "FATAL: $PUBLIC_DUMP missing" >&2; exit 1; }
[ -f "$AUTH_DUMP" ]   || { echo "FATAL: $AUTH_DUMP missing" >&2; exit 1; }

if [ "${1:-}" = "--force" ]; then
  echo "--force: removing existing $CONTAINER"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    docker start "$CONTAINER" >/dev/null
  else
    docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres \
      -p "$PORT:5432" "$IMAGE" >/dev/null
  fi
fi

echo "waiting for $CONTAINER postgres..."
for i in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 \
     && "${V1PSQL[@]}" -c "select 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  [ "$i" = 60 ] && { echo "FATAL: postgres not ready" >&2; exit 1; }
done

# ---- idempotency marker: complete restore == expected row counts ------------
expected="13|193|197"
have=$("${V1PSQL[@]}" -At -c \
  "select (select count(*) from public.aircraft) || '|' ||
          (select count(*) from public.flight_legs) || '|' ||
          (select count(*) from public.flight_leg_logs)" 2>/dev/null || echo none)
if [ "$have" = "$expected" ]; then
  echo "v1source already restored (aircraft|legs|logs = $have) — nothing to do."
  exit 0
fi
if [ "$have" != none ]; then
  echo "FATAL: v1source has a PARTIAL restore ($have, want $expected)." >&2
  echo "Re-run with --force to rebuild the container from scratch." >&2
  exit 1
fi

# ---- 1. patch auth.users to accept the hosted-project column set ------------
echo "patching auth.users columns..."
"${ADMPSQL[@]}" <<'SQL'
alter table auth.users
  add column if not exists email_confirmed_at timestamptz,
  add column if not exists phone text,
  add column if not exists phone_confirmed_at timestamptz,
  add column if not exists phone_change text default '',
  add column if not exists phone_change_token text default '',
  add column if not exists phone_change_sent_at timestamptz,
  add column if not exists email_change_token_new text,
  add column if not exists email_change_token_current text default '',
  add column if not exists email_change_confirm_status smallint default 0,
  add column if not exists banned_until timestamptz,
  add column if not exists reauthentication_token text default '',
  add column if not exists reauthentication_sent_at timestamptz,
  add column if not exists is_sso_user boolean not null default false,
  add column if not exists deleted_at timestamptz,
  add column if not exists is_anonymous boolean not null default false;
SQL

# ---- 2. minimal storage tables (data-only dump needs them to exist) ---------
echo "creating storage.buckets / storage.objects..."
"${ADMPSQL[@]}" <<'SQL'
create table if not exists storage.buckets (
  id text primary key,
  name text,
  owner uuid,
  created_at timestamptz,
  updated_at timestamptz,
  public boolean,
  avif_autodetection boolean,
  file_size_limit bigint,
  allowed_mime_types text[],
  owner_id text,
  type text
);
create table if not exists storage.objects (
  id uuid primary key,
  bucket_id text,
  name text,
  owner uuid,
  created_at timestamptz,
  updated_at timestamptz,
  last_accessed_at timestamptz,
  metadata jsonb,
  version text,
  owner_id text,
  user_metadata jsonb
);
SQL

# ---- 3. restore auth.users + storage data (selective TOC) -------------------
echo "restoring auth.users + storage.buckets/objects data..."
TOC=$(mktemp)
"$PG_RESTORE" -l "$AUTH_DUMP" \
  | grep -E "TABLE DATA (auth users|storage buckets |storage objects) " > "$TOC"
"$PG_RESTORE" -h 127.0.0.1 -p "$PORT" -U supabase_admin -d postgres \
  --no-owner --no-privileges -L "$TOC" "$AUTH_DUMP"
rm -f "$TOC"

# ---- 4. restore the public schema dump (schema + data) ----------------------
# v1 used extensions.moddatetime() in its updated_at triggers.
"${V1PSQL[@]}" -c "create extension if not exists moddatetime schema extensions;" \
              -c "create extension if not exists pg_trgm schema extensions;"
# Skip the SCHEMA/COMMENT entries for pre-existing `public`.
echo "restoring public schema dump..."
TOC=$(mktemp)
"$PG_RESTORE" -l "$PUBLIC_DUMP" \
  | grep -v -E "SCHEMA - public|COMMENT - SCHEMA public" > "$TOC"
"$PG_RESTORE" -h 127.0.0.1 -p "$PORT" -U postgres -d postgres \
  --no-owner --no-privileges -L "$TOC" "$PUBLIC_DUMP"
rm -f "$TOC"

# ---- 5. verify --------------------------------------------------------------
echo "verifying..."
"${V1PSQL[@]}" -At <<'SQL'
select 'aircraft='          || count(*) from public.aircraft
union all select 'flight_legs='       || count(*) from public.flight_legs
union all select 'flight_leg_logs='   || count(*) from public.flight_leg_logs
union all select 'maintenance='       || count(*) from public.aircraft_maintenance_log
union all select 'flight_notes='      || count(*) from public.flight_notes
union all select 'user_profiles='     || count(*) from public.user_profiles
union all select 'auth_users='        || count(*) from auth.users
union all select 'storage_objects='   || count(*) from storage.objects;
SQL

have=$("${V1PSQL[@]}" -At -c \
  "select (select count(*) from public.aircraft) || '|' ||
          (select count(*) from public.flight_legs) || '|' ||
          (select count(*) from public.flight_leg_logs)")
if [ "$have" = "$expected" ]; then
  echo "v1source restore COMPLETE ($have)"
else
  echo "FATAL: restore verification failed ($have, want $expected)" >&2
  exit 1
fi
