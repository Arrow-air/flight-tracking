"""End-to-end processing of one .bin log: parse -> sanitize -> verify.

Shared by the offline CLI (run.py) and the queue watcher (watcher.py).
"""

from __future__ import annotations

import os
import tempfile
from typing import Any

from pymavlink import mavutil

from .sanitize import DROP_TYPES, sanitize_file
from .summary import file_meta, parse_log

# Verification tolerance per RUN-CONTEXT: "same duration/battery summary +-1%"
TOLERANCE = 0.01


def _pct_close(a, b, tol=TOLERANCE) -> bool:
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    if a == b:
        return True
    denom = max(abs(a), abs(b))
    if denom == 0:
        return True
    return abs(a - b) / denom <= tol


def verify_sanitized(sanitized_path: str, raw_result: dict,
                     cells: int | None) -> dict[str, Any]:
    """Re-parse the sanitized copy with pymavlink and check the contract:

    1. parses cleanly (pymavlink accepts it end to end);
    2. contains ZERO dropped-type messages and zero nonzero lat/lng fields;
    3. duration + battery summary agree with the raw parse within 1%.
    """
    problems: list[str] = []

    # 2. location scan (independent full pass with pymavlink itself)
    mlog = mavutil.mavlink_connection(sanitized_path)
    loc_msgs = 0
    nonzero_latlng = 0
    msgs = 0
    while True:
        m = mlog.recv_match()
        if m is None:
            break
        msgs += 1
        mtype = m.get_type()
        if mtype in DROP_TYPES:
            loc_msgs += 1
            continue
        for field in ("Lat", "Lng", "Lon"):
            v = getattr(m, field, None)
            if v not in (None, 0, 0.0):
                nonzero_latlng += 1
                break
    if msgs == 0:
        problems.append("sanitized file yielded 0 messages")
    if loc_msgs:
        problems.append(f"{loc_msgs} location-type messages survived")
    if nonzero_latlng:
        problems.append(f"{nonzero_latlng} messages with nonzero Lat/Lng survived")

    # 3. summary comparison
    san = parse_log(sanitized_path, cells=cells)
    rs, ss = raw_result["summary"], san["summary"]
    comps = {
        "duration_s": (rs["duration_s"], ss["duration_s"]),
        "log_duration_s": (rs.get("log_duration_s"), ss.get("log_duration_s")),
        "armed_duration_s": (rs["armed_duration_s"], ss["armed_duration_s"]),
        "batt_volt_min": (rs["battery"]["volt_min"], ss["battery"]["volt_min"]),
        "batt_sag_v": (rs["battery"]["sag_v"], ss["battery"]["sag_v"]),
        "batt_mah_used": (rs["battery"]["mah_used"], ss["battery"]["mah_used"]),
    }
    for name, (a, b) in comps.items():
        if not _pct_close(a, b):
            problems.append(f"{name} mismatch raw={a} sanitized={b} (>1%)")

    # A sanitized log has all GPS dropped, so re-parsing it must yield NO
    # takeoff coordinate at all — anything else is a location leak in the
    # public artifact.
    for key in ("takeoff_lat", "takeoff_lon"):
        if ss.get(key) is not None:
            problems.append(
                f"sanitized parse produced {key}={ss[key]} (location leak)")

    return {
        "ok": not problems,
        "problems": problems,
        "messages_scanned": msgs,
        "comparisons": {k: {"raw": a, "sanitized": b}
                        for k, (a, b) in comps.items()},
    }


def process_file(path: str, out_dir: str | None = None,
                 cells: int | None = None,
                 verify: bool = True) -> dict[str, Any]:
    """Parse + sanitize one log. Returns dict with summary/series/params,
    sanitize stats, verification result, and the sanitized file path."""
    if out_dir is None:
        out_dir = tempfile.mkdtemp(prefix="arrow-parser-")
    os.makedirs(out_dir, exist_ok=True)

    meta = file_meta(path)
    result = parse_log(path, cells=cells)

    base = os.path.splitext(os.path.basename(path))[0]
    sanitized_path = os.path.join(out_dir, f"{base}.sanitized.bin")
    stats = sanitize_file(path, sanitized_path)

    verification = None
    if verify:
        verification = verify_sanitized(sanitized_path, result, cells)

    return {
        "file": meta,
        "summary": result["summary"],
        "series": result["series"],
        "params": result["params"],
        "sanitized_path": sanitized_path,
        "sanitize_stats": stats.as_dict(),
        "verification": verification,
    }
