"""v2.2 parser fixes (work items P1 / P2, run/RUN-CONTEXT-V22.md).

P1 — duration_s = FLIGHT time (summed armed spans, same arm/disarm detection
the battery stats window uses), falling back to full log span when a log has
no arm events; total span preserved as log_duration_s; duration_source
records which window applied (battery.stats_window pattern).

P2 — first-fix validity guard: a "fix" at/near (0, 0) (GPS-stripped uploads
zero Lat/Lng while keeping Status>=3) is NOT a fix — takeoff coords and
distance must come out null.

Integration proof (P1): fixtures/nas-logs/00000027.BIN IS the prod log
387be26687b7_00000027.BIN from flight bd0ee3e6-7ff7-4242-bd80-f5cbaacd57ed
(sha256 verified in run/ARCH-NOTES-V22.md §2) — the log whose duration_s was
3745.21 on prod. Its flight time must land ~570 s.

Fixture-dependent tests skip cleanly when fixtures/ (gitignored) is absent.
"""

from __future__ import annotations

import os

import pytest

from arrow_parser import db, sanitize
from arrow_parser.summary import (
    _assemble_armed_intervals,
    _plausible_fix,
    parse_log,
)

REPO_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURES = os.path.join(REPO_ROOT, "fixtures", "nas-logs")
SMALL_FIXTURE = os.path.join(FIXTURES, "00000021.BIN")   # 5.5 s, no arm events
BUG_FIXTURE = os.path.join(FIXTURES, "00000027.BIN")     # prod bd0ee3e6 log
MIGRATION = os.path.join(
    REPO_ROOT, "supabase", "migrations",
    "20260812130000_v22_duration_semantics.sql")

needs_small = pytest.mark.skipif(
    not os.path.exists(SMALL_FIXTURE),
    reason="fixtures/nas-logs (gitignored) not present on this machine")
needs_bug_log = pytest.mark.skipif(
    not os.path.exists(BUG_FIXTURE),
    reason="fixtures/nas-logs (gitignored) not present on this machine")


# ---------------------------------------------------------------------------
# P1 unit: armed-interval assembly (the shared battery-window code path)


def test_multi_arm_cycles_sum_spans():
    events = [(10.0, True), (20.0, False), (100.0, True), (145.0, False)]
    armed_s, intervals = _assemble_armed_intervals(events, 0.0, 200.0)
    assert armed_s == pytest.approx(55.0)
    assert intervals == [(10.0, 20.0), (100.0, 145.0)]


def test_no_arm_events_yields_empty():
    armed_s, intervals = _assemble_armed_intervals([], 0.0, 100.0)
    assert armed_s == 0.0
    assert intervals == []


def test_leading_disarm_means_armed_from_log_start():
    armed_s, intervals = _assemble_armed_intervals([(50.0, False)], 2.0, 100.0)
    assert armed_s == pytest.approx(48.0)
    assert intervals == [(2.0, 50.0)]


def test_trailing_arm_means_armed_to_log_end():
    armed_s, intervals = _assemble_armed_intervals([(60.0, True)], 0.0, 100.0)
    assert armed_s == pytest.approx(40.0)
    assert intervals == [(60.0, 100.0)]


def test_consecutive_same_state_events_collapse():
    events = [(10.0, True), (12.0, True), (30.0, False), (31.0, False)]
    armed_s, intervals = _assemble_armed_intervals(events, 0.0, 100.0)
    assert armed_s == pytest.approx(20.0)
    assert intervals == [(10.0, 30.0)]


def test_unsorted_events_are_sorted_first():
    events = [(30.0, False), (10.0, True)]
    armed_s, intervals = _assemble_armed_intervals(events, 0.0, 100.0)
    assert armed_s == pytest.approx(20.0)
    assert intervals == [(10.0, 30.0)]


# ---------------------------------------------------------------------------
# P2 unit: first-fix validity guard


@pytest.mark.parametrize("lat,lng", [
    (0.0, 0.0),               # exact null island (stripped log)
    (0.004, -0.004),          # would round to (0.00, 0.00) at 2 dp
    (1e-7, 0.0),              # near-zero residual, one axis exactly zero
    (None, -103.49),
    (30.04, None),
    (91.0, 0.0),              # out of range
    (30.04, 181.0),
])
def test_implausible_fixes_rejected(lat, lng):
    assert not _plausible_fix(lat, lng)


@pytest.mark.parametrize("lat,lng", [
    (30.04, -103.49),         # the real fixture site
    (0.0, 51.5),              # equator crossing with real longitude
    (51.5, 0.0),              # Greenwich with real latitude
    (-89.99, 179.99),
])
def test_plausible_fixes_accepted(lat, lng):
    assert _plausible_fix(lat, lng)


# ---------------------------------------------------------------------------
# P1 parse-level: no-arm-events fallback (00000021.BIN has zero arm events)


@needs_small
def test_no_arm_fallback_uses_full_log_span():
    s = parse_log(SMALL_FIXTURE)["summary"]
    assert s["duration_source"] == "full_log"
    assert s["duration_s"] == s["log_duration_s"]
    assert s["duration_s"] > 0
    assert s["armed_duration_s"] == 0.0
    # fallback label matches the battery window label for the same log
    assert s["battery"]["stats_window"].startswith("full_log")


# ---------------------------------------------------------------------------
# P2 parse-level: GPS-stripped log (Status>=3 kept, Lat/Lng zeroed) -> nulls


@pytest.fixture(scope="module")
def stripped_gps_log(tmp_path_factory):
    """Build an Erick-style stripped log: keep every message (including GPS
    with its fix Status) but zero all lat/lng-named fields — exactly what
    sanitize_bytes does to KEPT messages, so run it with DROP_TYPES empty."""
    if not os.path.exists(SMALL_FIXTURE):
        pytest.skip("fixtures/nas-logs (gitignored) not present")
    with open(SMALL_FIXTURE, "rb") as f:
        data = f.read()
    orig = sanitize.DROP_TYPES
    sanitize.DROP_TYPES = set()
    try:
        stripped, stats = sanitize.sanitize_bytes(data)
    finally:
        sanitize.DROP_TYPES = orig
    assert stats.zeroed_fields.get("GPS"), "fixture must have zeroed GPS msgs"
    path = tmp_path_factory.mktemp("v22-stripped") / "stripped.bin"
    path.write_bytes(stripped)
    return str(path)


def test_stripped_gps_log_yields_null_coords(stripped_gps_log):
    s = parse_log(stripped_gps_log)["summary"]
    assert s["takeoff_lat"] is None
    assert s["takeoff_lon"] is None
    assert s["distance_m"] is None      # no valid fixes -> no haversine sum
    # the raw parse of the same fixture DOES find coords (guard is the diff)
    raw = parse_log(SMALL_FIXTURE)["summary"]
    assert raw["takeoff_lat"] == 30.04
    assert raw["takeoff_lon"] == -103.49
    # duration semantics unaffected by coordinate stripping
    assert s["duration_s"] == raw["duration_s"]
    assert s["duration_source"] == raw["duration_source"]


# ---------------------------------------------------------------------------
# P1 integration: THE prod bug log (flight bd0ee3e6, 387be26687b7_00000027.BIN)


@pytest.fixture(scope="module")
def bug_log_summary():
    if not os.path.exists(BUG_FIXTURE):
        pytest.skip("fixtures/nas-logs (gitignored) not present")
    return parse_log(BUG_FIXTURE)["summary"]


@needs_bug_log
def test_bd0ee3e6_duration_is_flight_time_not_log_span(bug_log_summary):
    s = bug_log_summary
    # prod bug value was 3745.21 (total span); events AUTO_ARMED t=2163.5 ->
    # DISARMED t=2733.5 (~570 s armed; ARM.ArmState msg arms a few s earlier)
    assert 540 <= s["duration_s"] <= 600, s["duration_s"]
    assert s["duration_source"] == "armed"
    assert s["duration_s"] == s["armed_duration_s"]
    assert s["log_duration_s"] == pytest.approx(3745.21, abs=1.0)
    assert s["battery"]["stats_window"].startswith("armed")


@needs_bug_log
def test_bd0ee3e6_takeoff_coords(bug_log_summary):
    assert bug_log_summary["takeoff_lat"] == pytest.approx(30.04, abs=0.011)
    assert bug_log_summary["takeoff_lon"] == pytest.approx(-103.49, abs=0.011)


# ---------------------------------------------------------------------------
# db row + migration name agreement (introspection picks columns up by name)


def test_summary_row_carries_new_duration_fields():
    s = {
        "duration_s": 570.0, "duration_source": "armed",
        "log_duration_s": 3745.21, "armed_duration_s": 570.0,
        "distance_m": 1.0, "max_alt_m": 1.0, "max_speed_ms": 1.0,
        "start_time_utc": None, "takeoff_lat": None, "takeoff_lon": None,
        "vehicle": None, "battery": {}, "health": {}, "modes": [],
        "events": [], "errors": [],
    }
    row = db.build_summary_row("log-1", s)
    assert row["log_duration_s"] == 3745.21
    assert row["duration_source"] == "armed"
    assert row["duration_s"] == 570.0


def test_migration_defines_the_columns_db_sends():
    assert os.path.exists(MIGRATION), MIGRATION
    with open(MIGRATION) as f:
        sql = f.read()
    assert "alter table public.flight_log_summary" in sql
    assert "add column log_duration_s numeric" in sql
    assert "add column duration_source text" in sql
    assert "'armed', 'full_log'" in sql
