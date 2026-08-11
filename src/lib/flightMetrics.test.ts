import { describe, expect, it } from 'vitest';
import {
  embeddedSummary,
  flightDurationS,
  flightStartIso,
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
