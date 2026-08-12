import { describe, expect, it } from 'vitest';
import {
  embeddedSummary,
  flightDurationS,
  flightStartIso,
  flightWeatherCoords,
  modeTimeline,
  type LogWithSummary,
} from './flightMetrics';

describe('embeddedSummary', () => {
  it('normalizes the object form of a PostgREST one-to-one embed', () => {
    expect(embeddedSummary({ flight_log_summary: { duration_s: 42 } })).toEqual({
      duration_s: 42,
    });
  });

  it('normalizes the array form', () => {
    expect(embeddedSummary({ flight_log_summary: [{ duration_s: 7 }] })).toEqual({
      duration_s: 7,
    });
  });

  it('returns null for null / missing / empty-array embeds', () => {
    expect(embeddedSummary({ flight_log_summary: null })).toBeNull();
    expect(embeddedSummary({})).toBeNull();
    expect(embeddedSummary({ flight_log_summary: [] })).toBeNull();
  });
});

describe('flightDurationS (E1)', () => {
  it('prefers summed parser duration_s over wall-clock times', () => {
    const logs: LogWithSummary[] = [
      { flight_log_summary: { duration_s: 100 } },
      { flight_log_summary: [{ duration_s: 50 }] },
    ];
    // wall clock says 1h — summary must win
    expect(
      flightDurationS(logs, '2026-08-11T10:00:00Z', '2026-08-11T11:00:00Z'),
    ).toBe(150);
  });

  it('falls back to ended-started when no summary duration exists', () => {
    const logs: LogWithSummary[] = [{ flight_log_summary: { duration_s: null } }];
    expect(
      flightDurationS(logs, '2026-08-11T10:00:00Z', '2026-08-11T10:05:30Z'),
    ).toBe(330);
  });

  it('bulk-uploaded shape: logs with summaries but no ended_at (the E1 bug)', () => {
    const logs: LogWithSummary[] = [{ flight_log_summary: { duration_s: 612.4 } }];
    expect(flightDurationS(logs, '2026-08-11T10:00:00Z', null)).toBe(612.4);
  });

  it('returns null when nothing is known', () => {
    expect(flightDurationS([], null, null)).toBeNull();
    expect(flightDurationS(undefined, '2026-08-11T10:00:00Z', null)).toBeNull();
  });

  it('ignores unparseable wall-clock strings', () => {
    expect(flightDurationS([], 'nonsense', 'also nonsense')).toBeNull();
  });
});

describe('flightStartIso (F3)', () => {
  it('prefers the earliest log-derived start_time_utc over started_at', () => {
    const logs: LogWithSummary[] = [
      { flight_log_summary: { start_time_utc: '2026-08-11T10:30:00Z' } },
      { flight_log_summary: [{ start_time_utc: '2026-08-11T10:10:00Z' }] },
    ];
    expect(flightStartIso(logs, '2026-08-11T09:00:00Z')).toBe('2026-08-11T10:10:00Z');
  });

  it('falls back to started_at when no summary carries a start time', () => {
    const logs: LogWithSummary[] = [{ flight_log_summary: { start_time_utc: null } }];
    expect(flightStartIso(logs, '2026-08-11T09:00:00Z')).toBe('2026-08-11T09:00:00Z');
  });

  it('returns null when neither exists (started_at now optional)', () => {
    expect(flightStartIso([], null)).toBeNull();
    expect(flightStartIso(undefined, undefined)).toBeNull();
  });

  it('skips invalid summary timestamps', () => {
    const logs: LogWithSummary[] = [{ flight_log_summary: { start_time_utc: 'garbage' } }];
    expect(flightStartIso(logs, '2026-08-11T09:00:00Z')).toBe('2026-08-11T09:00:00Z');
  });
});

describe('flightWeatherCoords (D1)', () => {
  const site = { lat: 40.0, lon: -105.0 };

  it('prefers the log summary coarse takeoff coords over the site', () => {
    const logs: LogWithSummary[] = [
      { flight_log_summary: { takeoff_lat: 37.12, takeoff_lon: -122.65 } },
    ];
    expect(flightWeatherCoords(logs, site)).toEqual({
      lat: 37.12,
      lon: -122.65,
      source: 'log',
    });
  });

  it('accepts PostgREST numeric-as-string values', () => {
    const logs: LogWithSummary[] = [
      { flight_log_summary: [{ takeoff_lat: '37.12', takeoff_lon: '-122.65' }] },
    ];
    expect(flightWeatherCoords(logs, null)).toEqual({
      lat: 37.12,
      lon: -122.65,
      source: 'log',
    });
  });

  it('skips logs without coords and falls back to the site', () => {
    const logs: LogWithSummary[] = [
      { flight_log_summary: { takeoff_lat: null, takeoff_lon: null } },
      { flight_log_summary: null },
    ];
    expect(flightWeatherCoords(logs, site)).toEqual({
      lat: 40.0,
      lon: -105.0,
      source: 'site',
    });
  });

  it('requires BOTH lat and lon from the same summary', () => {
    const logs: LogWithSummary[] = [
      { flight_log_summary: { takeoff_lat: 37.12, takeoff_lon: null } },
    ];
    expect(flightWeatherCoords(logs, site)).toEqual({
      lat: 40.0,
      lon: -105.0,
      source: 'site',
    });
  });

  it('returns null when neither log nor site has coordinates', () => {
    expect(flightWeatherCoords([], { lat: null, lon: null })).toBeNull();
    expect(flightWeatherCoords(undefined, null)).toBeNull();
  });
});

describe('modeTimeline (P1 v2.2 — absolute t_s, duration_s no longer an endpoint)', () => {
  it('bd0ee3e6 bug-log shape: pad idle before arming never yields a negative segment', () => {
    // Real prod numbers: last mode change t_s≈2163.5 (absolute log seconds),
    // DISARMED event t_s=2733.5, post-fix duration_s=573.7 (armed time).
    // The old code used duration_s as the last end → to - from = -1589.8.
    const segs = modeTimeline({
      modes: [
        { t_s: 2159.8, mode: 'STABILIZE' },
        { t_s: 2163.5, mode: 'AUTO' },
      ],
      events: [
        { t_s: 2163.5 }, // AUTO_ARMED
        { t_s: 2733.5 }, // DISARMED
      ],
    });
    expect(segs).toEqual([
      { mode: 'STABILIZE', from: 2159.8, to: 2163.5 },
      { mode: 'AUTO', from: 2163.5, to: 2733.5 },
    ]);
    for (const s of segs) {
      if (s.to != null) expect(s.to).toBeGreaterThanOrEqual(s.from);
    }
  });

  it('uses the latest event t_s even when events are unsorted', () => {
    const segs = modeTimeline({
      modes: [{ t_s: 10, mode: 'LOITER' }],
      events: [{ t_s: 500 }, { t_s: 90 }],
    });
    expect(segs).toEqual([{ mode: 'LOITER', from: 10, to: 500 }]);
  });

  it('leaves the last segment open when no event is later than the last mode change', () => {
    const segs = modeTimeline({
      modes: [
        { t_s: 5, mode: 'STABILIZE' },
        { t_s: 60, mode: 'RTL' },
      ],
      events: [{ t_s: 12 }],
    });
    expect(segs[0]).toEqual({ mode: 'STABILIZE', from: 5, to: 60 });
    expect(segs[1]).toEqual({ mode: 'RTL', from: 60, to: null });
  });

  it('handles missing events / non-finite t_s / empty modes', () => {
    expect(modeTimeline({ modes: [{ t_s: 3, mode: 'AUTO' }] })).toEqual([
      { mode: 'AUTO', from: 3, to: null },
    ]);
    expect(
      modeTimeline({
        modes: [{ t_s: 3, mode: 'AUTO' }],
        events: [{ t_s: Number.NaN }],
      }),
    ).toEqual([{ mode: 'AUTO', from: 3, to: null }]);
    expect(modeTimeline({ modes: null, events: null })).toEqual([]);
    expect(modeTimeline({})).toEqual([]);
  });
});
