#!/usr/bin/env python3
"""Offline CLI for the Arrow flight-log parser.

    parser/.venv/bin/python parser/run.py <file.bin> [options]

Parses a DataFlash .bin, writes summary/series/params JSON plus the
sanitized .bin copy to --out, and (by default) verifies the sanitized
copy re-parses with matching duration/battery within 1%.

Exit codes: 0 ok, 1 parse failure, 2 sanitize verification failure.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from arrow_parser.pipeline import process_file  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="Arrow DataFlash log parser (offline)")
    ap.add_argument("bin_file", help="path to a DataFlash .bin log")
    ap.add_argument("--out", default=None,
                    help="output dir (default: parser/out/<logname>/)")
    ap.add_argument("--cells", type=int, default=None,
                    help="battery cell count from aircraft_type (else inferred)")
    ap.add_argument("--no-verify", action="store_true",
                    help="skip sanitized-copy verification pass")
    ap.add_argument("--summary-only", action="store_true",
                    help="print summary JSON only, do not write files")
    ap.add_argument("--quiet", action="store_true",
                    help="print one status line instead of full JSON")
    args = ap.parse_args()

    path = os.path.abspath(args.bin_file)
    if not os.path.isfile(path):
        print(f"error: no such file: {path}", file=sys.stderr)
        return 1

    base = os.path.splitext(os.path.basename(path))[0]
    out_dir = args.out or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "out", base)

    t0 = time.time()
    try:
        result = process_file(path, out_dir=out_dir, cells=args.cells,
                              verify=not args.no_verify)
    except Exception as e:  # noqa: BLE001 - CLI boundary
        print(f"error: parse failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    elapsed = time.time() - t0

    if not args.summary_only:
        with open(os.path.join(out_dir, f"{base}.summary.json"), "w") as f:
            json.dump({"file": result["file"], "summary": result["summary"],
                       "sanitize_stats": result["sanitize_stats"],
                       "verification": result["verification"]}, f, indent=2)
        with open(os.path.join(out_dir, f"{base}.series.json"), "w") as f:
            json.dump(result["series"], f)
        with open(os.path.join(out_dir, f"{base}.params.json"), "w") as f:
            json.dump(result["params"], f, indent=2, sort_keys=True)

    ver = result["verification"]
    if args.quiet:
        s = result["summary"]
        status = "OK" if (ver is None or ver["ok"]) else "VERIFY-FAIL"
        print(f"{status} {os.path.basename(path)} "
              f"dur={s['duration_s']}s armed={s['armed_duration_s']}s "
              f"dist={s['distance_m']}m alt={s['max_alt_m']}m "
              f"health={s['health']['score']} "
              f"params={len(result['params'])} "
              f"series={len(result['series'])}ch "
              f"({elapsed:.1f}s)")
    else:
        out = {"file": result["file"], "summary": result["summary"],
               "sanitize_stats": result["sanitize_stats"],
               "verification": ver, "elapsed_s": round(elapsed, 2)}
        if not args.summary_only:
            out["outputs"] = {
                "dir": out_dir,
                "sanitized_bin": result["sanitized_path"],
            }
        print(json.dumps(out, indent=2))

    if ver is not None and not ver["ok"]:
        for p in ver["problems"]:
            print(f"VERIFY: {p}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
