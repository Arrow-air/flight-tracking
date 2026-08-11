"""v2.1 schema+parser slice tests (work items D1 / F3 / privacy contract).

Covers:
- D1: parser emits COARSE takeoff coords (round(2) inside the parser),
  matching the first good GPS fix; nothing with more precision leaves.
- Privacy: re-parsing the SANITIZED artifact yields no takeoff coords, and
  the raw-parse outputs contain no value at the precise fix location.
- F3: start_time_utc flows into the flight_log_summary row db.py builds
  (unix seconds -> tz-aware datetime for the timestamptz column), and
  db.py's column introspection keeps/drops the new keys correctly against
  both the post-migration and the pre-migration schema.
- Migration cross-check: the columns db.py sends actually exist in the
  migration SQL (names must match for introspection to pick them up).

Fixture-dependent tests skip cleanly when fixtures/ (gitignored) is absent.
"""

from __future__ import annotations

import math
import os
from datetime import datetime, timezone

import pytest
from pymavlink import mavutil

from arrow_parser import db
from arrow_parser.pipeline import process_file, verify_sanitized
from arrow_parser.summary import parse_log

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURE = os.path.join(REPO_ROOT, "fixtures", "nas-logs", "00000021.BIN")
MIGRATION = os.path.join(
    REPO_ROOT, "supabase", "migrations",
    "20260811120000_v21_summary_takeoff_start_incident.sql")

needs_fixture = pytest.mark.skipif(
    not os.path.exists(FIXTURE),
    reason="fixtures/nas-logs (gitignored) not present on this machine")


# ---------------------------------------------------------------------------
# helpers


def first_precise_fix(path):
    """Independently scan the raw log for the first fix the parser would
    record (instance 0, Status>=3, lat/lng not both zero)."""
    mlog = mavutil.mavlink_connection(path)
    while True:
        m = mlog.recv_match(type=["GPS"])
        if m is None:
            return None
        if getattr(m, "I", getattr(m, "Instance", 0)) not in (0, None):
            continue
        status = getattr(m, "Status", 0)
        if status is None or status < 3:
            continue
        lat, lng = getattr(m, "Lat", None), getattr(m, "Lng", None)
        if lat is not None and lng is not None and (lat or lng):
            return (lat, lng)


def walk_numbers(obj):
    """Yield every numeric leaf in a nested dict/list structure."""
    if isinstance(obj, bool):
        return
    if isinstance(obj, (int, float)):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from walk_numbers(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from walk_numbers(v)


@pytest.fixture(scope="module")
def raw_result():
    return parse_log(FIXTURE)


@pytest.fixture(scope="module")
def pipeline_result(tmp_path_factory):
    out = tmp_path_factory.mktemp("v21-pipeline")
    return process_file(FIXTURE, out_dir=str(out))


# ---------------------------------------------------------------------------
# D1: coarse takeoff coords


@needs_fixture
def test_takeoff_coords_match_first_fix_rounded(raw_result):
    precise = first_precise_fix(FIXTURE)
    assert precise is not None, "fixture must contain a good GPS fix"
    s = raw_result["summary"]
    assert s["takeoff_lat"] == round(precise[0], 2)
    assert s["takeoff_lon"] == round(precise[1], 2)
    # the fixture's real fix has >2 dp, so rounding must actually change it
    assert s["takeoff_lat"] != precise[0]
    assert s["takeoff_lon"] != precise[1]


@needs_fixture
def test_takeoff_coords_are_two_decimal_coarse(raw_result):
    s = raw_result["summary"]
    for key in ("takeoff_lat", "takeoff_lon"):
        v = s[key]
        assert v is not None
        assert v == round(v, 2), f"{key}={v} carries more than 2 dp"
    assert -90 <= s["takeoff_lat"] <= 90
    assert -180 <= s["takeoff_lon"] <= 180


@needs_fixture
def test_no_precise_coordinate_leaves_the_parser(raw_result):
    """No numeric value in summary/series/params may equal the precise fix
    (the coarse values differ from it by construction: fixture has >2 dp)."""
    precise = first_precise_fix(FIXTURE)
    emitted = {
        "summary": raw_result["summary"],
        "series": raw_result["series"],
        "params": raw_result["params"],
    }
    for v in walk_numbers(emitted):
        for p in precise:
            assert not math.isclose(v, p, rel_tol=0, abs_tol=1e-7), (
                f"precise coordinate {p} leaked into parser output as {v}")


def test_takeoff_coords_none_without_gps():
    """Rounding guard: summary shape when no fix exists (unit-level)."""
    first_fix = None
    lat = round(first_fix[0], 2) if first_fix else None
    assert lat is None


# ---------------------------------------------------------------------------
# privacy: sanitized artifact


@needs_fixture
def test_sanitized_parse_has_no_takeoff_coords(pipeline_result):
    san = parse_log(pipeline_result["sanitized_path"])
    s = san["summary"]
    assert s["takeoff_lat"] is None
    assert s["takeoff_lon"] is None
    assert s["distance_m"] is None  # no fixes at all in sanitized log


@needs_fixture
def test_pipeline_verification_green_with_coord_check(pipeline_result):
    v = pipeline_result["verification"]
    assert v is not None
    assert v["ok"], f"sanitize verification failed: {v['problems']}"


@needs_fixture
def test_verifier_flags_takeoff_coords_as_leak(raw_result):
    """If a 'sanitized' file still parsed to takeoff coords, verify_sanitized
    must report it. Feed the RAW file as the sanitized candidate."""
    v = verify_sanitized(FIXTURE, raw_result, cells=None)
    assert not v["ok"]
    assert any("location leak" in p for p in v["problems"]), v["problems"]


# ---------------------------------------------------------------------------
# F3: start_time_utc -> db row


@needs_fixture
def test_start_time_utc_flows_into_summary_row(raw_result):
    s = raw_result["summary"]
    assert isinstance(s["start_time_utc"], float)
    row = db.build_summary_row("log-1", s)
    dt = row["start_time_utc"]
    assert isinstance(dt, datetime)
    assert dt.tzinfo == timezone.utc
    assert dt.timestamp() == pytest.approx(s["start_time_utc"], abs=1e-3)
    assert row["takeoff_lat"] == s["takeoff_lat"]
    assert row["takeoff_lon"] == s["takeoff_lon"]


def test_utc_from_unix_none_passthrough():
    assert db.utc_from_unix(None) is None
    dt = db.utc_from_unix(1776103367.06)
    assert dt == datetime(2026, 4, 13, 18, 2, 47, 60000, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# db.py column introspection (the mechanism that "picks up" new columns)


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn
        self.rowcount = 1
        self._rows = []

    def execute(self, sql, params=None):
        if "information_schema.columns" in sql:
            table = params[0]
            self._rows = list(self.conn.columns.get(table, {}).items())
        else:
            self.conn.executed.append((sql, params))
            self._rows = []

    def fetchall(self):
        return self._rows

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeConn:
    def __init__(self, columns):
        self.columns = columns  # table -> {col: udt_name}
        self.executed = []

    def cursor(self):
        return FakeCursor(self)


PRE_MIGRATION_COLS = {
    "log_id": "uuid", "duration_s": "numeric", "distance_m": "numeric",
    "max_alt_m": "numeric", "max_speed_mps": "numeric", "battery": "jsonb",
    "health": "jsonb", "modes": "jsonb", "events": "jsonb", "errors": "jsonb",
    "wind": "jsonb", "created_at": "timestamptz", "updated_at": "timestamptz",
}
POST_MIGRATION_COLS = {
    **PRE_MIGRATION_COLS,
    "start_time_utc": "timestamptz",
    "takeoff_lat": "numeric",
    "takeoff_lon": "numeric",
}

SUMMARY = {
    "duration_s": 5.5, "armed_duration_s": 0.0, "distance_m": 0.0,
    "max_alt_m": 0.3, "max_speed_ms": 1.2, "start_time_utc": 1776103367.06,
    "takeoff_lat": 30.04, "takeoff_lon": -103.49, "vehicle": "ArduCopter",
    "battery": {}, "health": {}, "modes": [], "events": [], "errors": [],
}


def inserted_columns(conn):
    assert len(conn.executed) == 1
    sql, params = conn.executed[0]
    collist = sql.split("(", 1)[1].split(")", 1)[0]
    cols = [c.strip() for c in collist.split(",")]
    return dict(zip(cols, params))


def test_filtered_insert_picks_up_new_columns_post_migration():
    conn = FakeConn({"flight_log_summary": POST_MIGRATION_COLS})
    row = db.build_summary_row("log-1", SUMMARY)
    assert db._filtered_insert(conn, "flight_log_summary", row,
                               jsonb_overflow_col="summary",
                               conflict_col="log_id")
    cols = inserted_columns(conn)
    assert cols["start_time_utc"] == db.utc_from_unix(1776103367.06)
    assert cols["takeoff_lat"] == 30.04
    assert cols["takeoff_lon"] == -103.49
    # keys without columns are still dropped (no 'summary' overflow col)
    for absent in ("armed_duration_s", "vehicle", "summary", "max_speed_ms"):
        assert absent not in cols


def test_filtered_insert_drops_new_columns_pre_migration():
    """Backwards-safe: against the old schema the new keys just vanish."""
    conn = FakeConn({"flight_log_summary": PRE_MIGRATION_COLS})
    row = db.build_summary_row("log-1", SUMMARY)
    assert db._filtered_insert(conn, "flight_log_summary", row,
                               jsonb_overflow_col="summary",
                               conflict_col="log_id")
    cols = inserted_columns(conn)
    for absent in ("start_time_utc", "takeoff_lat", "takeoff_lon"):
        assert absent not in cols
    assert cols["duration_s"] == 5.5


# ---------------------------------------------------------------------------
# migration <-> db.py name agreement


def test_migration_defines_the_columns_db_sends():
    assert os.path.exists(MIGRATION), MIGRATION
    with open(MIGRATION) as f:
        sql = f.read()
    assert "alter table public.flight_log_summary" in sql
    for col in ("start_time_utc timestamptz",
                "takeoff_lat numeric(5, 2)",
                "takeoff_lon numeric(5, 2)"):
        assert col in sql, f"migration missing column def: {col}"
    # E2 incident field on flights
    assert "create type public.flight_incident" in sql
    assert "alter table public.flights" in sql
    assert "add column incident public.flight_incident" in sql
