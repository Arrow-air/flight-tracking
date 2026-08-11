"""Health scoring for a parsed DataFlash log.

Thresholds per RUN-CONTEXT "Parser" (ported from Hex's ArduPilot
flight-card work):
  - vibration warn        > 30 m/s^2         (RUN-CONTEXT, explicit)
  - accel clip events     > 0                (RUN-CONTEXT: "clip events")
  - EKF variance warn     > 0.5              (RUN-CONTEXT, explicit)
  - compass innovation    > 0.5 test ratio   (EKF SM channel; same 0.5 scale)
  - motor-output spread   imbalance          (threshold below is ASSUMPTION)
  - RC RSSI dropouts                          (threshold below is ASSUMPTION)

ASSUMPTION (labelled per RUN-CONTEXT rules — the source memory file with
exact numbers is not readable from this run): motor spread warns at >15%
of the active throttle range; RSSI dropout = sample below 20% of the
observed max, warn at >5 dropout events. Deduction weights are ASSUMPTION.
"""

from __future__ import annotations

from typing import Any

VIBE_WARN = 30.0          # m/s^2
CLIP_WARN = 0             # any clipping warns
EKF_VAR_WARN = 0.5        # test-ratio scale
COMPASS_WARN = 0.5        # EKF mag (SM) test ratio
MOTOR_SPREAD_WARN = 15.0  # % — ASSUMPTION
RSSI_DROPOUT_WARN = 5     # events — ASSUMPTION
RSSI_DROP_FRACTION = 0.2  # of observed max — ASSUMPTION

_DEDUCTIONS = {  # ASSUMPTION: weights chosen for a 0-100 scale
    "vibration": 15,
    "clipping": 10,
    "ekf_variance": 15,
    "compass": 10,
    "motor_balance": 10,
    "rc_link": 10,
    "errors": 10,
}


def _grade(score: int) -> str:
    if score >= 90:
        return "A"
    if score >= 75:
        return "B"
    if score >= 60:
        return "C"
    if score >= 40:
        return "D"
    return "F"


def compute_health(*, vibe_max: float, clip_total: int,
                   ekf_maxes: dict[str, float], ekf_over_ratio: float,
                   rcou_sums: dict[int, float], rcou_sqsums: dict[int, float],
                   rcou_n: int, rssi_vals: list[float],
                   error_count: int) -> dict[str, Any]:
    checks: list[dict] = []

    def check(name: str, ok: bool | None, value, threshold, detail=""):
        checks.append({
            "name": name,
            "status": "no_data" if ok is None else ("ok" if ok else "warn"),
            "value": value,
            "threshold": threshold,
            "detail": detail,
        })
        return ok is False

    score = 100

    if check("vibration", vibe_max <= VIBE_WARN if vibe_max else None,
             round(vibe_max, 1), VIBE_WARN, "max VIBE any axis m/s^2"):
        score -= _DEDUCTIONS["vibration"]

    if check("clipping", (clip_total <= CLIP_WARN) if vibe_max else None,
             clip_total, CLIP_WARN, "cumulative accel clip events"):
        score -= _DEDUCTIONS["clipping"]

    ekf_worst = max(ekf_maxes.values()) if ekf_maxes else 0.0
    have_ekf = any(v > 0 for v in ekf_maxes.values())
    if check("ekf_variance", ekf_worst <= EKF_VAR_WARN if have_ekf else None,
             round(ekf_worst, 3), EKF_VAR_WARN,
             f"worst of SV/SP/SH/SM; {ekf_over_ratio:.1%} of samples over"):
        score -= _DEDUCTIONS["ekf_variance"]

    sm = ekf_maxes.get("SM", 0.0)
    if check("compass", sm <= COMPASS_WARN if have_ekf else None,
             round(sm, 3), COMPASS_WARN, "EKF mag innovation test ratio"):
        score -= _DEDUCTIONS["compass"]

    # Motor balance: mean PWM per active output channel while armed.
    spread_pct = None
    if rcou_n > 10:
        means = {}
        for ch, s in rcou_sums.items():
            mean = s / rcou_n
            var = rcou_sqsums[ch] / rcou_n - mean * mean
            # active motor channel: moves and sits above idle
            if mean > 1100 and var > 25:
                means[ch] = mean
        if len(means) >= 3:  # multirotor motor set
            mx, mn = max(means.values()), min(means.values())
            avg = sum(means.values()) / len(means)
            rng = avg - 1000.0
            if rng > 50:
                spread_pct = (mx - mn) / rng * 100.0
    if check("motor_balance",
             spread_pct <= MOTOR_SPREAD_WARN if spread_pct is not None else None,
             round(spread_pct, 1) if spread_pct is not None else None,
             MOTOR_SPREAD_WARN, "% spread of mean motor PWM over throttle range"):
        score -= _DEDUCTIONS["motor_balance"]

    # RC link: dropouts below 20% of observed max RSSI.
    dropouts = None
    if rssi_vals:
        peak = max(rssi_vals)
        if peak > 0:
            floor = peak * RSSI_DROP_FRACTION
            dropouts = 0
            below = False
            for v in rssi_vals:
                if v < floor and not below:
                    dropouts += 1
                    below = True
                elif v >= floor:
                    below = False
    if check("rc_link",
             dropouts <= RSSI_DROPOUT_WARN if dropouts is not None else None,
             dropouts, RSSI_DROPOUT_WARN, "RSSI dropout events"):
        score -= _DEDUCTIONS["rc_link"]

    if check("errors", error_count == 0, error_count, 0,
             "ERR messages logged"):
        score -= _DEDUCTIONS["errors"]

    score = max(0, score)
    return {"score": score, "grade": _grade(score), "checks": checks}
