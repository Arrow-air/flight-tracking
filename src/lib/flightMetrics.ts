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
  /** D1: COARSE (2 dp, ~1.1 km) takeoff coordinate from the parser. */
  takeoff_lat?: number | string | null;
  takeoff_lon?: number | string | null;
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

// ---------------------------------------------------------------------------
// P1 (v2.2) — modes timeline segments.
//
// Mode/event `t_s` values are ABSOLUTE log seconds (parser: TimeUS / 1e6 —
// NOT offset to the log's first message), so a log that idles on the pad
// before arming has its first mode change at e.g. t_s ≈ 2163, not 0.
// duration_s is therefore NEVER a valid segment endpoint: under the v2.2
// semantics it is summed ARMED time (573.7 s on the bd0ee3e6 bug log while
// the last mode's t_s is ~2163 — using it made `to - from` negative), and
// even log_duration_s is a SPAN, not an absolute timestamp. The last
// segment's end is the latest absolute t_s observed across modes and
// events (DISARMED normally closes a real flight); when nothing later than
// the last mode change is known, `to` stays null and no duration renders.
// ---------------------------------------------------------------------------
export interface ModeSegment {
  mode: string;
  from: number;
  to: number | null;
}

export function modeTimeline(s: {
  modes?: { t_s: number; mode: string }[] | null;
  events?: { t_s: number }[] | null;
}): ModeSegment[] {
  const modes = s.modes ?? [];
  let lastTs = -Infinity;
  for (const e of s.events ?? []) {
    if (typeof e?.t_s === 'number' && Number.isFinite(e.t_s) && e.t_s > lastTs) {
      lastTs = e.t_s;
    }
  }
  return modes.map((m, i) => {
    const next = modes[i + 1]?.t_s ?? (lastTs > m.t_s ? lastTs : null);
    return { mode: m.mode, from: m.t_s, to: next };
  });
}

// ---------------------------------------------------------------------------
// D1 — weather coordinate source: prefer the log's coarse takeoff coords
// (parser-rounded to 2 dp), fall back to the site's coordinates.
// ---------------------------------------------------------------------------
export interface WeatherCoords {
  lat: number;
  lon: number;
  source: 'log' | 'site';
}

function asFiniteNumber(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * P2 (v2.2): a coordinate pair is usable for a weather lookup only when
 * both values are finite, in range, and NOT the null island. GPS-stripped
 * uploads zero their coords, and the parser's 2-dp rounding turns near-zero
 * residue into exactly (0.00, 0.00) — flight c39f3e92 fetched
 * equatorial-Atlantic weather that way. The epsilon (both |v| < 0.005,
 * i.e. anything that ROUNDS to the 2-dp null island) mirrors the parser's
 * _plausible_fix() guard. A single zero axis (equator/prime-meridian
 * crossing) is still valid.
 */
export function usableWeatherCoords(
  lat: number | string | null | undefined,
  lon: number | string | null | undefined,
): { lat: number; lon: number } | null {
  const la = asFiniteNumber(lat);
  const lo = asFiniteNumber(lon);
  if (la == null || lo == null) return null;
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  if (Math.abs(la) < 0.005 && Math.abs(lo) < 0.005) return null;
  return { lat: la, lon: lo };
}

/**
 * Pick the coordinate pair a weather lookup should use for a flight:
 * the first log summary carrying a USABLE coarse takeoff fix wins;
 * otherwise the site's coordinates (same usability bar); null when
 * neither exists. (numeric columns can arrive as strings through
 * PostgREST — both are accepted.)
 */
export function flightWeatherCoords(
  logs: LogWithSummary[] | null | undefined,
  site: { lat: number | null; lon: number | null } | null | undefined,
): WeatherCoords | null {
  for (const log of logs ?? []) {
    const s = embeddedSummary(log);
    const c = usableWeatherCoords(s?.takeoff_lat, s?.takeoff_lon);
    if (c) return { ...c, source: 'log' };
  }
  const siteCoords = usableWeatherCoords(site?.lat, site?.lon);
  if (siteCoords) return { ...siteCoords, source: 'site' };
  return null;
}
