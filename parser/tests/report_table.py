#!/usr/bin/env python3
"""Render a per-fixture results table from gate_round1.py JSON output.

Usage: parser/.venv/bin/python parser/tests/report_table.py results/gate-r1.json
"""

from __future__ import annotations

import json
import sys


def fmt_loc(d):
    if not d:
        return "-"
    return " ".join(f"{k}:{v}" for k, v in sorted(d.items()))


def main(path):
    with open(path) as f:
        data = json.load(f)
    rows = []
    hdr = ("fixture", "MB", "exit", "s", "dur_s", "pc_min", "loc_before",
           "loc_after", "latlng_after", "d_span%", "d_vmin%", "d_mah%",
           "verdict")
    rows.append(hdr)
    for r in data["results"]:
        raw = r.get("raw_scan") or {}
        san = r.get("san_scan") or {}
        pct = r.get("raw_vs_san_pct") or {}
        rows.append((
            r["name"],
            f"{r.get('size', 0) / 1e6:.1f}",
            str(r.get("cli_exit")),
            str(r.get("cli_s", "")),
            str(r.get("duration_s", "")),
            str(r.get("per_cell_min", "-")),
            fmt_loc(raw.get("loc_types")),
            fmt_loc(san.get("loc_types")),
            fmt_loc(san.get("loc_field_hits")),
            str(pct.get("span_s", "")),
            str(pct.get("volt_min", "")),
            str(pct.get("currtot_max(mAh)", "")),
            "PASS" if not r["problems"] else "FAIL: " + "; ".join(r["problems"])[:120],
        ))
    widths = [max(len(row[i]) for row in rows) for i in range(len(hdr))]
    for i, row in enumerate(rows):
        print("| " + " | ".join(c.ljust(w) for c, w in zip(row, widths)) + " |")
        if i == 0:
            print("|" + "|".join("-" * (w + 2) for w in widths) + "|")
    n_fail = data["n_fail"]
    print(f"\n{data['label']}: {data['n'] - n_fail}/{data['n']} green, "
          f"total {data['total_s']}s")


if __name__ == "__main__":
    main(sys.argv[1])
