#!/usr/bin/env python3
"""Queue watcher: parse flight_logs rows with status='uploaded'.

Contract (RUN-CONTEXT "Parser" / V2-PLAN "Parser service"):
  poll flight_logs WHERE status='uploaded' (FOR UPDATE SKIP LOCKED, so
  N workers are safe) -> download raw .bin from storage -> parse ->
  write flight_log_summary / flight_log_series / param_snapshots ->
  upload sanitized copy -> set sanitized_path, status='parsed'.
  Any failure -> status='error' (never silent).

Also LISTENs on channel 'flight_log_uploaded' (the pg_notify emitted by
migration 20260810210200_helpers.sql when a row enters status='uploaded')
to wake instantly; plain polling works without it.

Env: DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
     STORAGE_BUCKET, SANITIZED_BUCKET, POLL_INTERVAL_S (default 5),
     ONESHOT=1 (drain+exit).
"""

from __future__ import annotations

import logging
import os
import select
import sys
import tempfile
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from arrow_parser import db  # noqa: E402
from arrow_parser.pipeline import process_file  # noqa: E402
from arrow_parser.storage import Storage  # noqa: E402

log = logging.getLogger("watcher")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# Channel per migration 20260810210200_helpers.sql (tg_notify_flight_log_uploaded)
LISTEN_CHANNEL = os.environ.get("LISTEN_CHANNEL", "flight_log_uploaded")


def sanitized_object_path(object_path: str) -> str:
    """Sanitized copy lives in the 'flight-logs-sanitized' bucket at the
    SAME object path as the raw log (bucket separation per migration
    20260810210500_storage.sql; the path is recorded in
    flight_logs.sanitized_path)."""
    return object_path


def cells_for_log(conn, rec: dict) -> int | None:
    """aircraft_type.cells via flight -> aircraft -> aircraft_types.
    Tolerant of the schema not being fully landed."""
    flight_id = rec.get("flight_id")
    if flight_id is None:
        return None
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT at.cells FROM flights f "
                "JOIN aircraft a ON a.id = f.aircraft_id "
                "JOIN aircraft_types at ON at.id = a.type_id "
                "WHERE f.id = %s", (flight_id,))
            row = cur.fetchone()
            return row[0] if row else None
    except Exception:
        conn.rollback()
        return None


def process_one(conn, storage: Storage, rec: dict) -> None:
    log_id = rec["id"]
    object_path = rec.get("object_path") or rec.get("path")
    if not object_path:
        raise RuntimeError("flight_logs row has no object_path")
    log.info("claimed log %s (%s)", log_id, object_path)

    with tempfile.TemporaryDirectory(prefix="arrow-parse-") as tmp:
        raw_path = os.path.join(tmp, "raw.bin")
        storage.download(object_path, raw_path)

        cells = cells_for_log(conn, rec)
        result = process_file(raw_path, out_dir=tmp, cells=cells, verify=True)

        ver = result["verification"]
        if ver and not ver["ok"]:
            raise RuntimeError(
                "sanitized verification failed: " + "; ".join(ver["problems"]))

        san_obj = sanitized_object_path(object_path)
        storage.upload(san_obj, result["sanitized_path"],
                       bucket=storage.sanitized_bucket)
        db.write_results(conn, log_id, result, sanitized_path=san_obj)
    s = result["summary"]
    log.info("parsed log %s: dur=%.1fs health=%s", log_id,
             s["duration_s"], s["health"]["score"])


def main() -> int:
    poll_s = float(os.environ.get("POLL_INTERVAL_S", "5"))
    oneshot = os.environ.get("ONESHOT") == "1"
    storage = Storage()
    conn = db.connect()
    try:
        with conn.cursor() as cur:
            cur.execute(f"LISTEN {LISTEN_CHANNEL}")
        conn.commit()
    except Exception:
        conn.rollback()

    log.info("watcher up (poll=%ss oneshot=%s bucket=%s)",
             poll_s, oneshot, storage.bucket)
    while True:
        try:
            rec = db.claim_next_uploaded(conn)
        except Exception as e:
            # table may not exist yet while schema phase runs
            conn.rollback()
            log.warning("queue poll failed (%s) — retrying in %ss",
                        e, poll_s)
            if oneshot:
                return 1
            time.sleep(poll_s)
            continue

        if rec is None:
            if oneshot:
                log.info("queue empty — oneshot exit")
                return 0
            # sleep, but wake early on NOTIFY
            try:
                select.select([conn.fileno()], [], [], poll_s)
                conn.execute("SELECT 1")  # consume any notifies
            except Exception:
                time.sleep(poll_s)
            continue

        try:
            process_one(conn, storage, rec)
        except Exception as e:  # noqa: BLE001 - worker boundary
            log.error("log %s failed: %s\n%s", rec.get("id"), e,
                      traceback.format_exc())
            try:
                db.mark_error(conn, rec["id"],
                              f"{type(e).__name__}: {e}")
            except Exception as e2:  # noqa: BLE001
                log.error("could not mark error on %s: %s", rec.get("id"), e2)
                conn = db.connect()


if __name__ == "__main__":
    sys.exit(main())
