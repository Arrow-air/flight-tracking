"""Postgres access for the parser queue.

The schema phase runs in parallel with this service, so writes are
column-introspecting: we look up the actual columns of
flight_log_summary / flight_log_series / param_snapshots / flight_logs at
runtime and only write intersecting fields. Anything the schema does not
have a dedicated column for lands in a jsonb column when one exists.

Env:
  DATABASE_URL  (default: local supabase stack
                 postgresql://postgres:postgres@127.0.0.1:54322/postgres)
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"


def connect() -> psycopg.Connection:
    return psycopg.connect(os.environ.get("DATABASE_URL", DEFAULT_DB_URL))


def table_columns(conn: psycopg.Connection, table: str) -> dict[str, str]:
    """column name -> udt_name (e.g. 'jsonb', '_float8', 'text')."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT column_name, udt_name FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name=%s", (table,))
        return {r[0]: r[1] for r in cur.fetchall()}


def claim_next_uploaded(conn: psycopg.Connection) -> dict[str, Any] | None:
    """Atomically claim one flight_logs row with status='uploaded'.

    Uses FOR UPDATE SKIP LOCKED so multiple workers are safe. Flips the row
    to 'parsing' in the same transaction and returns it, or None if queue
    is empty.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT * FROM flight_logs WHERE status='uploaded' "
            "ORDER BY uploaded_at NULLS LAST, id LIMIT 1 "
            "FOR UPDATE SKIP LOCKED")
        row = cur.fetchone()
        if row is None:
            conn.commit()
            return None
        cols = [d.name for d in cur.description]
        rec = dict(zip(cols, row))
        cur.execute("UPDATE flight_logs SET status='parsing' WHERE id=%s",
                    (rec["id"],))
        conn.commit()
        return rec


def _filtered_insert(conn, table: str, candidate: dict[str, Any],
                     jsonb_overflow_col: str | None = None,
                     conflict_col: str | None = None) -> bool:
    """Insert `candidate` keeping only columns that exist on `table`.
    Unknown keys are folded into `jsonb_overflow_col` if the table has it.
    Returns False if the table doesn't exist (schema not landed yet)."""
    cols = table_columns(conn, table)
    if not cols:
        return False
    row = {k: v for k, v in candidate.items() if k in cols}
    leftover = {k: v for k, v in candidate.items()
                if k not in cols and k != jsonb_overflow_col}
    if jsonb_overflow_col and jsonb_overflow_col in cols:
        base = candidate.get(jsonb_overflow_col) or {}
        row[jsonb_overflow_col] = {**leftover, **base} if leftover else base

    def adapt(col: str, v):
        # wrap dicts/lists as Jsonb only when the column is json/jsonb;
        # plain lists pass through as native Postgres arrays.
        if isinstance(v, (dict, list)) and cols.get(col) in ("json", "jsonb"):
            return Jsonb(v)
        return v

    row = {k: adapt(k, v) for k, v in row.items()}
    keys = list(row.keys())
    placeholders = ", ".join(["%s"] * len(keys))
    collist = ", ".join(keys)
    sql = f"INSERT INTO {table} ({collist}) VALUES ({placeholders})"
    if conflict_col and conflict_col in cols:
        updates = ", ".join(f"{k}=EXCLUDED.{k}" for k in keys
                            if k != conflict_col)
        sql += f" ON CONFLICT ({conflict_col}) DO UPDATE SET {updates}"
    with conn.cursor() as cur:
        cur.execute(sql, [row[k] for k in keys])
        if cur.rowcount == 0:
            raise RuntimeError(
                f"INSERT into {table} affected 0 rows (RLS swallow?)")
    return True


def utc_from_unix(unix_s: float | None) -> datetime | None:
    """Parser start_time_utc is unix seconds; the flight_log_summary column
    (migration 20260811120000) is timestamptz, so convert to a tz-aware
    datetime psycopg can adapt. None passes through."""
    if unix_s is None:
        return None
    return datetime.fromtimestamp(unix_s, tz=timezone.utc)


def build_summary_row(log_id: Any, s: dict[str, Any]) -> dict[str, Any]:
    """Candidate flight_log_summary row from a parser summary dict.
    _filtered_insert keeps only keys with real columns, so keys may lead
    the schema; takeoff_lat/lon arrive already rounded to 2 dp (summary.py
    owns the privacy coarsening — nothing here may add precision)."""
    return {
        "log_id": log_id,
        "duration_s": s["duration_s"],
        "duration_source": s.get("duration_source"),
        "log_duration_s": s.get("log_duration_s"),
        "armed_duration_s": s["armed_duration_s"],
        "distance_m": s["distance_m"],
        "max_alt_m": s["max_alt_m"],
        "max_speed_ms": s["max_speed_ms"],
        "max_speed_mps": s["max_speed_ms"],  # landed schema column name
        "start_time_utc": utc_from_unix(s.get("start_time_utc")),
        "takeoff_lat": s.get("takeoff_lat"),
        "takeoff_lon": s.get("takeoff_lon"),
        "vehicle": s["vehicle"],
        "battery": s["battery"],
        "health": s["health"],
        "modes": s["modes"],
        "events": s["events"],
        "errors": s["errors"],
        "summary": s,  # jsonb overflow / full blob if column exists
    }


def write_results(conn: psycopg.Connection, log_id: Any,
                  result: dict[str, Any], sanitized_path: str | None) -> None:
    """Write summary/series/params + flip flight_logs to parsed.
    One transaction; raises (and rolls back) on any 0-row write."""
    s = result["summary"]
    try:
        summary_row = build_summary_row(log_id, s)
        if not _filtered_insert(conn, "flight_log_summary", summary_row,
                                jsonb_overflow_col="summary",
                                conflict_col="log_id"):
            raise RuntimeError("table flight_log_summary does not exist yet")

        series_cols = table_columns(conn, "flight_log_series")
        if series_cols:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM flight_log_series WHERE log_id=%s",
                            (log_id,))
            for ch in result["series"]:
                _filtered_insert(conn, "flight_log_series", {
                    "log_id": log_id,
                    "channel": ch["channel"],
                    "t": ch["t"],
                    "v": ch["v"],
                    "n_raw": ch["n_raw"],
                })

        _filtered_insert(conn, "param_snapshots", {
            "log_id": log_id,
            "params": result["params"],
        }, conflict_col="log_id")

        fl_cols = table_columns(conn, "flight_logs")
        sets = ["status='parsed'"]
        vals: list[Any] = []
        if "sanitized_path" in fl_cols and sanitized_path:
            sets.append("sanitized_path=%s")
            vals.append(sanitized_path)
        if "parsed_at" in fl_cols:
            sets.append("parsed_at=now()")
        vals.append(log_id)
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE flight_logs SET {', '.join(sets)} WHERE id=%s", vals)
            if cur.rowcount == 0:
                raise RuntimeError("flight_logs status update affected 0 rows")
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def mark_error(conn: psycopg.Connection, log_id: Any, message: str) -> None:
    try:
        fl_cols = table_columns(conn, "flight_logs")
        # landed schema (20260810210100_tables.sql) calls the column `error`;
        # `parse_error` kept as fallback for older scratch schemas
        err_col = ("error" if "error" in fl_cols
                   else ("parse_error" if "parse_error" in fl_cols else None))
        with conn.cursor() as cur:
            if err_col:
                cur.execute(f"UPDATE flight_logs SET status='error', "
                            f"{err_col}=%s WHERE id=%s",
                            (message[:2000], log_id))
            else:
                cur.execute("UPDATE flight_logs SET status='error' "
                            "WHERE id=%s", (log_id,))
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def json_default(o):
    return json.JSONEncoder().default(o)
