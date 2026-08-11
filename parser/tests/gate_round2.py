#!/usr/bin/env python3
"""Critic gate harness — parser round 2.

Owned by the critic agent (builder must not touch parser/tests/).

Same checks as gate_round1.py (which it imports) but writes to its OWN
out dir (tests/out-r2/) and results file (results/gate-r2.json) so it can
run concurrently with the round-2 full-corpus process, which uses
tests/out/ and results/corpus-r1.json — the 10 sampled NAS fixtures are
shared between the two sets and must not clobber each other.

Additionally records `battery.stats_window` per fixture (the round-2 fix
under test: post-landing power-off transient exclusion).

Usage: parser/.venv/bin/python parser/tests/gate_round2.py
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate_round1 as g1  # noqa: E402

# Redirect per-fixture CLI output to a round-2-only tree (collision guard).
g1.OUT_DIR = os.path.join(g1.TESTS_DIR, "out-r2")


def main():
    ok = g1.run_set(
        g1.gate_fixtures(), deep=True,
        out_json=os.path.join(g1.RESULTS_DIR, "gate-r2.json"),
        label="gate-r2 (PT1 + test12 + SITL + 10 NAS, deep, critic re-run)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
