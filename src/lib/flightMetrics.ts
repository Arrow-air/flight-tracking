/**
 * Pure helpers for deriving flight-level display values from embedded
 * flight_log_summary rows. The parser's numbers win over hand-entered
 * times: duration prefers summed summary duration_s (E1), start prefers
 * the log-derived start_time_utc (F3), falling back to the flight row.
 *
 * PostgREST returns a one-to-one embed as an object OR a one-element
 * array depending on version — normalize both (same defensive shape as
 * FleetList/FlightCard).
 */

export interface SummaryLite {
  duration_s?: number | null;
  start_time_utc?: string | null;
}

export interface LogWithSummary {
  flight_log_summary?: SummaryLite | SummaryLite[] | null;
}

/** Normalize a PostgREST one-to-one embed (object | array | null). */
export function embeddedSummary(log: LogWithSummary): SummaryLite | null {
  const s = log.flight_log_summary;
  if (s == null) return null;
  return Array.isArray(s) ? (s[0] ?? null) : s;
}

/**
 * Best duration for a flight in seconds: sum of parsed summary
 * duration_s across its logs when any exist, else wall-clock
 * ended-started, else null.
 */
export function flightDurationS(
  logs: LogWithSummary[] | null | undefined,
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): number | null {
  let sum = 0;
  let found = false;
  for (const log of logs ?? []) {
    const d = embeddedSummary(log)?.duration_s;
    if (d != null && Number.isFinite(d)) {
      sum += d;
      found = true;
    }
  }
  if (found) return sum;
  if (startedAt && endedAt) {
    const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    if (!Number.isNaN(ms)) return ms / 1000;
  }
  return null;
}

/**
 * Best start time (ISO string): earliest log-derived start_time_utc when
 * present, else the flight row's started_at.
 */
export function flightStartIso(
  logs: LogWithSummary[] | null | undefined,
  startedAt: string | null | undefined,
): string | null {
  let best: string | null = null;
  let bestMs = Infinity;
  for (const log of logs ?? []) {
    const t = embeddedSummary(log)?.start_time_utc;
    if (!t) continue;
    const ms = new Date(t).getTime();
    if (!Number.isNaN(ms) && ms < bestMs) {
      bestMs = ms;
      best = t;
    }
  }
  return best ?? startedAt ?? null;
}
