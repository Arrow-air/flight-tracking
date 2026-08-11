"""Extract summary / series / params from an ArduPilot DataFlash .bin log.

Uses pymavlink DFReader. Everything is computed in one pass with a message
type filter. Designed so the same function works on a sanitized log (no
GPS/POS messages): duration and battery numbers must agree with the raw
parse within 1% (verified by run.py --verify / the pipeline).
"""

from __future__ import annotations

import hashlib
import math
import os
from typing import Any

from pymavlink import mavutil

from .health import compute_health

# Message types consumed for the summary pass.
_TYPES = [
    "GPS", "BARO", "BAT", "CURR", "MODE", "EV", "ERR", "PARM",
    "VIBE", "RCOU", "XKF4", "NKF4", "RSSI", "MSG", "ARM", "STAT",
]

SERIES_MAX_POINTS = 600

# ArduPilot ERR subsystem ids (LogStructure / defines.h).
ERR_SUBSYS = {
    1: "MAIN", 2: "RADIO", 3: "COMPASS", 4: "OPTFLOW", 5: "FS_RADIO",
    6: "FS_BATT", 7: "FS_GPS", 8: "FS_GCS", 9: "FS_FENCE",
    10: "FLIGHT_MODE", 11: "GPS", 12: "CRASH_CHECK", 13: "FLIP",
    14: "AUTOTUNE", 15: "PARACHUTES", 16: "EKFCHECK", 17: "FS_EKFINAV",
    18: "BARO", 19: "CPU", 20: "FS_ADSB", 21: "TERRAIN", 22: "NAVIGATION",
    23: "FS_TERRAIN", 24: "EKF_PRIMARY", 25: "THRUST_LOSS_CHECK",
    26: "FS_SENSORS", 27: "INTERNAL_ERROR", 28: "FS_VIBE",
}

_EV_NAMES = {
    10: "ARMED", 11: "DISARMED", 15: "AUTO_ARMED", 17: "LAND_COMPLETE_MAYBE",
    18: "LAND_COMPLETE", 28: "NOT_LANDED", 25: "SET_HOME",
    56: "TAKEOFF_COMPLETE", 57: "TOUCHDOWN",
}


def _haversine_m(lat1, lon1, lat2, lon2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def _downsample(t: list[float], v: list[float], max_points: int = SERIES_MAX_POINTS):
    n = len(t)
    if n <= max_points:
        return t, v
    stride = n / max_points
    idx = [int(i * stride) for i in range(max_points)]
    return [t[i] for i in idx], [v[i] for i in idx]


def _infer_cells(volt_first: float | None) -> int | None:
    """Guess LiPo cell count from initial pack voltage (near-full assumption).

    ASSUMPTION: pack starts reasonably charged; per-cell in [3.3, 4.35] V,
    pick the count whose per-cell voltage is closest to 4.05 V.
    """
    if not volt_first or volt_first <= 0:
        return None
    best, best_err = None, 1e9
    for c in range(2, 17):
        per = volt_first / c
        if 3.30 <= per <= 4.35:
            err = abs(per - 4.05)
            if err < best_err:
                best, best_err = c, err
    return best


def _flight_volt_stats(samples: list[tuple[float, float]],
                       armed_intervals: list[tuple[float, float]],
                       cells_guess: int | None):
    """Flight-window volt_min / volt_max from full-rate (t, volt) samples.

    Some real logs capture the battery being switched OFF after landing:
    voltage collapses (e.g. 53-57 V -> 22-26 V -> 0) in the final seconds.
    Whole-log min/max would report that shutdown transient as flight battery
    stats (seen on 3/18 PT1 fixtures). Two-stage exclusion:

    1. Window to the armed span (first arm .. last disarm) when arm events
       exist — power-off happens after disarm on every observed fixture.
    2. Trim a trailing collapse suffix regardless: terminal samples below
       ~2.5 V/cell (or 0.6x pack max when cells unknown) that never recover,
       plus a 1 s guard band before the collapse to catch mid-fall samples.
       This covers logs whose disarm event is missing or logged after
       power-off.

    Returns (volt_min, volt_max, window_label).
    """
    if not samples:
        return None, None, None
    sel = samples
    label = "full_log"
    if armed_intervals:
        lo = armed_intervals[0][0]
        hi = armed_intervals[-1][1]
        windowed = [s for s in sel if lo <= s[0] <= hi]
        if windowed:
            sel = windowed
            label = "armed"
    vmax_all = max(v for _, v in sel)
    # Collapse threshold: safely below any legitimate loaded sag (~3.0 V/cell)
    # but above the post-power-off residual (observed 1.6-2.0 V/cell).
    thresh = 2.5 * cells_guess if cells_guess else 0.6 * vmax_all
    thresh = min(thresh, 0.7 * vmax_all)
    j = len(sel) - 1
    while j >= 0 and sel[j][1] < thresh:
        j -= 1
    if 0 <= j < len(sel) - 1:
        # terminal collapse suffix found: drop it plus a 1 s guard band so
        # samples captured mid-fall don't leak into the stats
        cut_t = sel[j + 1][0] - 1.0
        trimmed = [s for s in sel[: j + 1] if s[0] <= cut_t]
        sel = trimmed or sel[: j + 1]
        label += "+collapse_trimmed"
    vmin = min(v for _, v in sel)
    vmax = max(v for _, v in sel)
    return vmin, vmax, label


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_log(path: str, cells: int | None = None) -> dict[str, Any]:
    """One-pass parse. Returns {summary, series, params}."""
    mlog = mavutil.mavlink_connection(path)

    t_min_us = None
    t_max_us = None
    first_ts_unix = None  # GPS-derived wall clock of first good fix

    # battery — volt min/max are computed POST-loop from volt_samples so the
    # flight window (armed span / collapse trim) can be applied; whole-log
    # min/max would pick up the post-landing battery power-off transient.
    volt_first = None
    volt_samples: list[tuple[float, float]] = []
    curr_max = None
    mah_used = None
    energy_wh = None

    # gps — first_fix/last_fix hold PRECISE coords and must stay local to
    # this function; only the round(2) takeoff values below may be emitted.
    dist_m = 0.0
    first_fix = None
    last_fix = None
    max_speed = None
    gps_max_alt = None
    gps_first_alt = None

    baro_max = None

    modes: list[dict] = []
    events: list[dict] = []
    errors: list[dict] = []
    params: dict[str, float] = {}
    msg_counts: dict[str, int] = {}
    vehicle = None

    # arm-state transitions from EV 10/11 and ARM.ArmState; intervals are
    # assembled post-loop (real logs often START already armed because
    # logging begins at arm — first event seen can be a disarm).
    arm_events: list[tuple[float, bool]] = []

    # series accumulators: name -> (t[], v[])
    series: dict[str, tuple[list, list]] = {}

    # health accumulators
    vibe_max = 0.0
    clip_max = [0, 0, 0]
    ekf_maxes = {"SV": 0.0, "SP": 0.0, "SH": 0.0, "SM": 0.0}
    ekf_over = 0
    ekf_n = 0
    rcou_sums: dict[int, float] = {}
    rcou_sqsums: dict[int, float] = {}
    rcou_n = 0
    rssi_vals: list[float] = []

    def t_s(m) -> float | None:
        us = getattr(m, "TimeUS", None)
        return us / 1e6 if us is not None else None

    def push(name: str, ts: float | None, val) -> None:
        # real logs contain NaN samples (e.g. BAT.Curr on PT1 hardware)
        if ts is None or val is None or not math.isfinite(val):
            return
        ch = series.setdefault(name, ([], []))
        ch[0].append(round(ts, 3))
        ch[1].append(float(val))

    def fin(val):
        """None-ify non-finite floats (NaN/Inf are invalid JSON)."""
        if val is None:
            return None
        try:
            return val if math.isfinite(val) else None
        except TypeError:
            return None

    while True:
        m = mlog.recv_match(type=_TYPES)
        if m is None:
            break
        mtype = m.get_type()
        msg_counts[mtype] = msg_counts.get(mtype, 0) + 1
        us = getattr(m, "TimeUS", None)
        if us is not None:
            if t_min_us is None or us < t_min_us:
                t_min_us = us
            if t_max_us is None or us > t_max_us:
                t_max_us = us
        ts = t_s(m)

        if mtype == "GPS":
            status = getattr(m, "Status", 0)
            inst = getattr(m, "I", getattr(m, "Instance", 0))
            if inst not in (0, None):
                continue
            if status is not None and status >= 3:
                lat, lng = getattr(m, "Lat", None), getattr(m, "Lng", None)
                if first_ts_unix is None:
                    first_ts_unix = getattr(m, "_timestamp", None)
                if lat is not None and lng is not None and (lat or lng):
                    if first_fix is None:
                        first_fix = (lat, lng)
                    if last_fix is not None:
                        d = _haversine_m(last_fix[0], last_fix[1], lat, lng)
                        if d < 500:  # glitch guard
                            dist_m += d
                    last_fix = (lat, lng)
                spd = fin(getattr(m, "Spd", None))
                if spd is not None:
                    if max_speed is None or spd > max_speed:
                        max_speed = spd
                    push("gnd_speed_ms", ts, spd)
                alt = fin(getattr(m, "Alt", None))
                if alt is not None:
                    if gps_first_alt is None:
                        gps_first_alt = alt
                    if gps_max_alt is None or alt > gps_max_alt:
                        gps_max_alt = alt

        elif mtype == "BARO":
            inst = getattr(m, "I", getattr(m, "Instance", 0))
            if inst not in (0, None):
                continue
            alt = fin(getattr(m, "Alt", None))
            if alt is not None:
                if baro_max is None or alt > baro_max:
                    baro_max = alt
                push("baro_alt_m", ts, alt)

        elif mtype in ("BAT", "CURR"):
            inst = getattr(m, "Inst", getattr(m, "Instance", 0))
            if inst not in (0, None):
                continue
            v = fin(getattr(m, "Volt", None))
            c = fin(getattr(m, "Curr", None))
            tot = fin(getattr(m, "CurrTot", None))
            enrg = fin(getattr(m, "EnrgTot", None))
            if v is not None and v > 1.0:
                if volt_first is None:
                    volt_first = v
                if ts is not None:
                    volt_samples.append((ts, v))
                push("batt_volt", ts, v)
            if c is not None:
                if curr_max is None or c > curr_max:
                    curr_max = c
                push("batt_curr_a", ts, c)
            if tot is not None and tot > 0:
                mah_used = tot
            if enrg is not None and enrg > 0:
                energy_wh = enrg

        elif mtype == "MODE":
            name = getattr(mlog, "flightmode", None)
            num = getattr(m, "ModeNum", getattr(m, "Mode", None))
            modes.append({"t_s": ts, "mode": name or str(num), "mode_num": num})

        elif mtype == "EV":
            ev_id = getattr(m, "Id", None)
            events.append({"t_s": ts, "id": ev_id,
                           "event": _EV_NAMES.get(ev_id, f"EV_{ev_id}")})
            if ts is not None and ev_id in (10, 11):
                arm_events.append((ts, ev_id == 10))

        elif mtype == "ERR":
            sub = getattr(m, "Subsys", None)
            errors.append({"t_s": ts, "subsys": ERR_SUBSYS.get(sub, str(sub)),
                           "code": getattr(m, "ECode", None)})

        elif mtype == "PARM":
            name = getattr(m, "Name", None)
            if name:
                params[str(name)] = fin(getattr(m, "Value", None))

        elif mtype == "VIBE":
            inst = getattr(m, "IMU", getattr(m, "Instance", 0))
            if inst not in (0, None):
                continue
            vx = fin(getattr(m, "VibeX", 0)) or 0
            vy = fin(getattr(m, "VibeY", 0)) or 0
            vz = fin(getattr(m, "VibeZ", 0)) or 0
            vibe_max = max(vibe_max, vx, vy, vz)
            for k, c in (("Clip0", 0), ("Clip1", 1), ("Clip2", 2)):
                cv = fin(getattr(m, k, None))
                if cv is not None and cv > clip_max[c]:
                    clip_max[c] = cv
            push("vibe_x", ts, vx)
            push("vibe_y", ts, vy)
            push("vibe_z", ts, vz)

        elif mtype in ("XKF4", "NKF4"):
            core = getattr(m, "C", 0)
            if core not in (0, None):
                continue
            ekf_n += 1
            over = False
            for k in ("SV", "SP", "SH", "SM"):
                val = fin(getattr(m, k, None))
                if val is not None:
                    if val > ekf_maxes[k]:
                        ekf_maxes[k] = val
                    if val > 0.5:
                        over = True
            if over:
                ekf_over += 1
            push("ekf_vel_var", ts, getattr(m, "SV", None))
            push("ekf_pos_var", ts, getattr(m, "SP", None))
            push("ekf_mag_var", ts, getattr(m, "SM", None))

        elif mtype == "ARM":
            st = getattr(m, "ArmState", None)
            if ts is not None and st is not None:
                arm_events.append((ts, bool(st)))

        elif mtype == "RCOU":
            vals = {}
            for ch in range(1, 13):
                val = getattr(m, f"C{ch}", None)
                if val is not None and val > 0:
                    vals[ch] = val
            # motors-spinning gate (armed state may be unknown mid-log):
            if vals and max(vals.values()) > 1150:
                rcou_n += 1
                for ch, val in vals.items():
                    rcou_sums[ch] = rcou_sums.get(ch, 0.0) + val
                    rcou_sqsums[ch] = rcou_sqsums.get(ch, 0.0) + val * val

        elif mtype == "RSSI":
            val = fin(getattr(m, "RXRSSI", None))
            if val is not None:
                rssi_vals.append(val)
                push("rssi", ts, val)

        elif mtype == "MSG":
            txt = str(getattr(m, "Message", ""))
            if vehicle is None:
                for veh in ("ArduCopter", "ArduPlane", "ArduRover", "ArduSub"):
                    if veh in txt:
                        vehicle = veh
                        break

    duration_s = ((t_max_us - t_min_us) / 1e6
                  if t_min_us is not None and t_max_us is not None else 0.0)

    # Assemble armed intervals. Logging usually starts at arm, so a leading
    # disarm event implies armed-from-log-start; a trailing arm implies
    # armed-to-log-end.
    armed_s = 0.0
    armed_intervals: list[tuple[float, float]] = []
    if arm_events:
        arm_events.sort(key=lambda e: e[0])
        cleaned: list[tuple[float, bool]] = []
        for ev in arm_events:
            if not cleaned or cleaned[-1][1] != ev[1]:
                cleaned.append(ev)
        if cleaned and cleaned[0][1] is False and t_min_us is not None:
            cleaned.insert(0, (t_min_us / 1e6, True))
        if cleaned and cleaned[-1][1] is True and t_max_us is not None:
            cleaned.append((t_max_us / 1e6, False))
        armed_from = None
        for ts_ev, armed in cleaned:
            if armed and armed_from is None:
                armed_from = ts_ev
            elif not armed and armed_from is not None:
                if ts_ev > armed_from:
                    armed_intervals.append((armed_from, ts_ev))
                armed_s += max(0.0, ts_ev - armed_from)
                armed_from = None

    cells_source = "aircraft_type"
    if cells is None:
        cells = _infer_cells(volt_first)
        cells_source = "inferred_from_voltage" if cells else "unknown"

    volt_min, volt_max, volt_window = _flight_volt_stats(
        volt_samples, armed_intervals, cells)

    sag_v = (volt_max - volt_min
             if volt_max is not None and volt_min is not None else None)
    battery = {
        "volt_start": volt_first,
        "volt_min": volt_min,
        "volt_max": volt_max,
        "sag_v": round(sag_v, 3) if sag_v is not None else None,
        "curr_max_a": curr_max,
        "mah_used": round(mah_used, 1) if mah_used is not None else None,
        "energy_wh": round(energy_wh, 2) if energy_wh is not None else None,
        "cells": cells,
        "cells_source": cells_source,
        "stats_window": volt_window,
        "per_cell_min": (round(volt_min / cells, 3)
                         if volt_min is not None and cells else None),
        "per_cell_sag": (round(sag_v / cells, 3)
                         if sag_v is not None and cells else None),
    }

    health = compute_health(
        vibe_max=vibe_max,
        clip_total=sum(clip_max),
        ekf_maxes=ekf_maxes,
        ekf_over_ratio=(ekf_over / ekf_n if ekf_n else 0.0),
        rcou_sums=rcou_sums,
        rcou_sqsums=rcou_sqsums,
        rcou_n=rcou_n,
        rssi_vals=rssi_vals,
        error_count=len(errors),
    )

    gps_agl = (gps_max_alt - gps_first_alt
               if gps_max_alt is not None and gps_first_alt is not None else None)
    summary = {
        "duration_s": round(duration_s, 2),
        "armed_duration_s": round(armed_s, 2),
        "distance_m": round(dist_m, 1) if last_fix is not None else None,
        "max_alt_m": (round(baro_max, 1) if baro_max is not None
                      else (round(gps_agl, 1) if gps_agl is not None else None)),
        "max_alt_source": ("baro" if baro_max is not None
                           else ("gps" if gps_agl is not None else None)),
        "max_speed_ms": round(max_speed, 2) if max_speed is not None else None,
        # D1 PRIVACY: takeoff coords are COARSE — rounded to 2 decimal places
        # (~1.1 km) here, before they leave the parser. flight_log_summary is
        # fleet-visible under RLS, so nothing more precise may be emitted.
        "takeoff_lat": round(first_fix[0], 2) if first_fix else None,
        "takeoff_lon": round(first_fix[1], 2) if first_fix else None,
        "start_time_utc": first_ts_unix,
        "vehicle": vehicle,
        "battery": battery,
        "modes": modes,
        "events": events,
        "errors": errors,
        "health": health,
        "message_counts": msg_counts,
    }

    series_out = []
    for name, (tt, vv) in series.items():
        dt, dv = _downsample(tt, vv)
        series_out.append({"channel": name, "t": dt, "v": dv,
                           "n_raw": len(tt)})

    return {"summary": summary, "series": series_out, "params": params}


def file_meta(path: str) -> dict:
    return {
        "name": os.path.basename(path),
        "size": os.path.getsize(path),
        "sha256": sha256_file(path),
    }
