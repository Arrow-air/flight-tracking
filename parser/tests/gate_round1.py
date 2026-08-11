#!/usr/bin/env python3
"""Critic gate harness — parser round 1.

Owned by the critic agent (builder must not touch parser/tests/).

For each fixture .bin:
  1. Run the builder's CLI (parser/run.py) as a subprocess -> must exit 0.
  2. INDEPENDENTLY re-scan both the raw log and the sanitized copy with
     pymavlink (this file's own code, not the builder's verifier):
       - enumerate message types present before/after
       - list location-bearing types found before/after (must be ZERO after)
       - detect nonzero Lat/Lng-style field values surviving in ANY kept type
       - compute duration span, BAT volt min and CurrTot max independently;
         raw vs sanitized must match within 1%
  3. Sanity-check the summary JSON the CLI wrote: duration > 0 and within
     the independently measured log span (+1%); battery per-cell voltage
     plausible (2.5..4.6 V/cell) when battery data exists.

Usage:
  parser/.venv/bin/python parser/tests/gate_round1.py gate    # 30-log gate
  parser/.venv/bin/python parser/tests/gate_round1.py corpus  # all 101 NAS

Writes JSON results to parser/tests/results/ and prints a table.
Exit 0 = all green, 1 = failures present.
"""

from __future__ import annotations

import glob
import json
import math
import os
import re
import subprocess
import sys
import time
from collections import Counter

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
PARSER_DIR = os.path.dirname(TESTS_DIR)
REPO = os.path.dirname(PARSER_DIR)
PY = os.path.join(PARSER_DIR, ".venv", "bin", "python")
RUN_PY = os.path.join(PARSER_DIR, "run.py")
RESULTS_DIR = os.path.join(TESTS_DIR, "results")
OUT_DIR = os.path.join(TESTS_DIR, "out")

sys.path.insert(0, os.path.join(PARSER_DIR, ".venv", "lib"))
from pymavlink import mavutil  # noqa: E402  (venv has pymavlink)

# Message types that are location-bearing per RUN-CONTEXT + DataFlash docs.
LOC_TYPES = {
    "GPS", "GPS2", "GPSB", "GPA", "GPA2", "GPAB", "POS", "ORGN", "HOME",
    "TERR", "RALY", "GRAW", "GRXH", "GRXS",
}
# Field names that carry latitude/longitude in fused messages (AHR2, CMD,
# MISE, SIM, ...). Bare Lat/Lng/Lon/Long, optionally prefixed by a
# non-letter (so PM.NLon, a loop counter, does NOT match).
LOC_FIELD_RE = re.compile(r"(?:^|[^A-Za-z])(Lat|Lng|Lon|Long|Latitude|Longitude)$")

PT1_GLOBS = [
    "/Users/hex/projects/project-quiver/flight-test/PT1/assets/001/logs/*.BIN",
    "/Users/hex/projects/project-quiver/flight-test/PT1/assets/002/logs/*.BIN",
]
TEST12 = ("/Users/hex/projects/arrow/project-flight-tracking/supabase/"
          "functions/mavlink-parser/test12.bin")
SITL = "/Users/hex/projects/quiver-dock/sim/sitl_wd/logs/00000001.BIN"
NAS_DIR = os.path.join(REPO, "fixtures", "nas-logs")


def nas_sample():
    """Every 10th file of fixtures/nas-logs sorted by name (positions
    10, 20, ..., 100 -> exactly 10 of 101)."""
    files = sorted(glob.glob(os.path.join(NAS_DIR, "*.BIN")))
    return [f for i, f in enumerate(files, start=1) if i % 10 == 0]


def gate_fixtures():
    fx = []
    for g in PT1_GLOBS:
        fx.extend(sorted(glob.glob(g)))
    fx.append(TEST12)
    fx.append(SITL)
    fx.extend(nas_sample())
    return fx


def scan(path):
    """Independent pymavlink scan: type counts, loc types, surviving nonzero
    lat/lng field values, TimeUS span, BAT volt min / CurrTot max."""
    m = mavutil.mavlink_connection(path)
    types = Counter()
    loc_field_hits = Counter()
    t_min = None
    t_max = None
    volt_min = None
    currtot_max = None
    while True:
        msg = m.recv_msg()
        if msg is None:
            break
        t = msg.get_type()
        types[t] += 1
        if t in ("BAD_DATA", "FMT", "FMTU", "UNIT", "MULT"):
            continue
        d = msg.to_dict()
        tus = d.get("TimeUS")
        if isinstance(tus, (int, float)) and tus > 0:
            if t_min is None or tus < t_min:
                t_min = tus
            if t_max is None or tus > t_max:
                t_max = tus
        if t == "BAT":
            v = d.get("Volt")
            if isinstance(v, (int, float)) and math.isfinite(v) and v > 0:
                volt_min = v if volt_min is None else min(volt_min, v)
            ct = d.get("CurrTot")
            if isinstance(ct, (int, float)) and math.isfinite(ct):
                currtot_max = ct if currtot_max is None else max(currtot_max, ct)
        if t not in LOC_TYPES:  # dropped types checked via `types` directly
            for f, v in d.items():
                if f == "mavpackettype":
                    continue
                if LOC_FIELD_RE.search(f) and isinstance(v, (int, float)) \
                        and math.isfinite(v) and v != 0:
                    loc_field_hits[f"{t}.{f}"] += 1
    span = None
    if t_min is not None and t_max is not None:
        span = (t_max - t_min) / 1e6
    return {
        "types": dict(types),
        "loc_types": {k: v for k, v in types.items() if k in LOC_TYPES},
        "loc_field_hits": dict(loc_field_hits),
        "span_s": span,
        "volt_min": volt_min,
        "currtot_max": currtot_max,
    }


def pct_delta(a, b):
    if a is None or b is None:
        return None
    if a == 0 and b == 0:
        return 0.0
    denom = max(abs(a), abs(b), 1e-9)
    return abs(a - b) / denom * 100.0


def check_one(bin_path, deep=True):
    """Run CLI + (optionally) independent scans. Returns result dict."""
    base = os.path.splitext(os.path.basename(bin_path))[0]
    tag = re.sub(r"[^A-Za-z0-9_.-]", "_",
                 os.path.relpath(bin_path, "/Users/hex/projects"))
    out = os.path.join(OUT_DIR, tag)
    r = {"fixture": bin_path, "name": os.path.basename(bin_path),
         "size": os.path.getsize(bin_path), "problems": []}
    t0 = time.time()
    proc = subprocess.run(
        [PY, RUN_PY, bin_path, "--out", out, "--quiet"],
        capture_output=True, text=True, timeout=900)
    r["cli_exit"] = proc.returncode
    r["cli_s"] = round(time.time() - t0, 1)
    r["cli_line"] = (proc.stdout or proc.stderr).strip().splitlines()[-1] \
        if (proc.stdout or proc.stderr).strip() else ""
    if proc.returncode != 0:
        r["problems"].append(
            f"CLI exit {proc.returncode}: {proc.stderr.strip()[:300]}")
        return r

    with open(os.path.join(out, f"{base}.summary.json")) as f:
        rep = json.load(f)
    s = rep["summary"]
    r["duration_s"] = s.get("duration_s")
    r["battery"] = s.get("battery")
    ver = rep.get("verification")
    r["builder_verify_ok"] = None if ver is None else ver.get("ok")
    if ver is not None and not ver.get("ok"):
        r["problems"].append(f"builder verification failed: {ver.get('problems')}")

    # summary sanity
    if not isinstance(s.get("duration_s"), (int, float)) or s["duration_s"] <= 0:
        r["problems"].append(f"duration_s not >0: {s.get('duration_s')}")
    batt = s.get("battery") or {}
    if batt.get("volt_min") is not None and batt.get("cells"):
        pc_min = batt["volt_min"] / batt["cells"]
        pc_max = (batt.get("volt_max") or batt["volt_min"]) / batt["cells"]
        r["per_cell_min"] = round(pc_min, 3)
        r["per_cell_max"] = round(pc_max, 3)
        if not (2.5 <= pc_min <= 4.6) or not (2.5 <= pc_max <= 4.6):
            r["problems"].append(
                f"implausible per-cell voltage: min={pc_min:.2f} "
                f"max={pc_max:.2f} (cells={batt['cells']})")

    if not deep:
        return r

    san_path = os.path.join(out, f"{base}.sanitized.bin")
    raw = scan(bin_path)
    san = scan(san_path)
    r["raw_scan"] = {k: raw[k] for k in
                     ("loc_types", "loc_field_hits", "span_s",
                      "volt_min", "currtot_max")}
    r["raw_types_n"] = len(raw["types"])
    r["san_scan"] = san
    r["san_types_n"] = len(san["types"])

    # duration within independently-measured log span
    if raw["span_s"] and isinstance(s.get("duration_s"), (int, float)):
        if s["duration_s"] > raw["span_s"] * 1.01:
            r["problems"].append(
                f"summary duration {s['duration_s']}s exceeds log span "
                f"{raw['span_s']:.1f}s")
    # ZERO location-bearing content after sanitize
    if san["loc_types"]:
        r["problems"].append(f"location types survive sanitize: {san['loc_types']}")
    if san["loc_field_hits"]:
        r["problems"].append(
            f"nonzero lat/lng fields survive sanitize: {san['loc_field_hits']}")
    # raw vs sanitized: duration + battery within 1% (independent computation)
    for label, a, b in (("span_s", raw["span_s"], san["span_s"]),
                        ("volt_min", raw["volt_min"], san["volt_min"]),
                        ("currtot_max(mAh)", raw["currtot_max"], san["currtot_max"])):
        if a is None and b is None:
            continue
        d = pct_delta(a, b)
        r.setdefault("raw_vs_san_pct", {})[label] = None if d is None else round(d, 3)
        if d is None or d > 1.0:
            r["problems"].append(
                f"raw vs sanitized {label} differs >1%: raw={a} san={b}")
    return r


def run_set(fixtures, deep, out_json, label):
    os.makedirs(RESULTS_DIR, exist_ok=True)
    results = []
    t0 = time.time()
    for i, fx in enumerate(fixtures, 1):
        print(f"[{i}/{len(fixtures)}] {fx}", flush=True)
        try:
            res = check_one(fx, deep=deep)
        except Exception as e:  # harness must never mask a failure as pass
            res = {"fixture": fx, "name": os.path.basename(fx),
                   "cli_exit": -1, "problems": [f"harness exception: {e!r}"]}
        results.append(res)
        status = "PASS" if not res["problems"] else "FAIL"
        print(f"    -> {status} {res.get('cli_line','')} "
              f"problems={res['problems']}", flush=True)
    total_s = time.time() - t0
    n_fail = sum(1 for r in results if r["problems"])
    payload = {"label": label, "total_s": round(total_s, 1),
               "n": len(results), "n_fail": n_fail, "results": results}
    with open(out_json, "w") as f:
        json.dump(payload, f, indent=2)
    print(f"\n{label}: {len(results) - n_fail}/{len(results)} green "
          f"in {total_s:.0f}s -> {out_json}", flush=True)
    return n_fail == 0


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "gate"
    if mode == "gate":
        ok = run_set(gate_fixtures(), deep=True,
                     out_json=os.path.join(RESULTS_DIR, "gate-r1.json"),
                     label="gate-r1 (PT1 + test12 + SITL + 10 NAS, deep)")
    elif mode == "corpus":
        files = sorted(glob.glob(os.path.join(NAS_DIR, "*.BIN")))
        ok = run_set(files, deep=True,
                     out_json=os.path.join(RESULTS_DIR, "corpus-r1.json"),
                     label="corpus-r1 (all NAS logs, deep)")
    else:
        print(f"unknown mode {mode}", file=sys.stderr)
        return 2
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
