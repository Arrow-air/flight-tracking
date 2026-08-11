import { describe, expect, it } from 'vitest';
import {
  builtByUser,
  filterAircraft,
  filterFlights,
  firstParam,
  flagParam,
  fleetFiltersToQuery,
  flightFiltersToQuery,
  hasFleetFilters,
  hasFlightFilters,
  localDateStr,
  parseFleetFilters,
  parseFlightFilters,
  sameQuery,
  type AircraftFilterable,
  type FlightFilterable,
} from './filters';

// ---------------------------------------------------------------------------
// query-param primitives
// ---------------------------------------------------------------------------
describe('query param helpers', () => {
  it('firstParam takes the first scalar of arrays and tolerates junk', () => {
    expect(firstParam('a')).toBe('a');
    expect(firstParam(['a', 'b'])).toBe('a');
    expect(firstParam(null)).toBe('');
    expect(firstParam(undefined)).toBe('');
    expect(firstParam([null])).toBe('');
    expect(firstParam(42)).toBe('');
  });

  it('flagParam accepts 1/true only', () => {
    expect(flagParam('1')).toBe(true);
    expect(flagParam('true')).toBe(true);
    expect(flagParam('TRUE')).toBe(true);
    expect(flagParam('0')).toBe(false);
    expect(flagParam('')).toBe(false);
    expect(flagParam(undefined)).toBe(false);
  });

  it('sameQuery compares serialized filter queries structurally', () => {
    expect(sameQuery({ a: '1' }, { a: '1' })).toBe(true);
    expect(sameQuery({ a: '1' }, { a: ['1'] })).toBe(true);
    expect(sameQuery({ a: '1' }, { a: '2' })).toBe(false);
    expect(sameQuery({}, { a: '1' })).toBe(false);
    expect(sameQuery({ a: '1' }, {})).toBe(false);
  });

  it('localDateStr renders the local calendar date and rejects garbage', () => {
    // midday UTC is the same calendar date in every tz within ±11 h
    expect(localDateStr('2026-08-11T12:00:00Z')).toBe('2026-08-11');
    expect(localDateStr('garbage')).toBeNull();
    expect(localDateStr(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C2 — fleet filters
// ---------------------------------------------------------------------------
const AC = (over: Partial<AircraftFilterable> = {}): AircraftFilterable => ({
  id: 'ac-1',
  type_id: 'type-quiver',
  status: 'active',
  built_by: 'user-m',
  created_by: 'user-c',
  ...over,
});

describe('fleet filters (C2)', () => {
  it('round-trips through URL query params', () => {
    const f = parseFleetFilters({ type: 'type-quiver', status: 'retired', mfg: '1' });
    expect(f).toEqual({ type: 'type-quiver', status: 'retired', mfg: true, op: false });
    expect(fleetFiltersToQuery(f)).toEqual({
      type: 'type-quiver',
      status: 'retired',
      mfg: '1',
    });
    expect(parseFleetFilters(fleetFiltersToQuery(f))).toEqual(f);
  });

  it('empty state serializes to an empty query (clean URLs)', () => {
    const f = parseFleetFilters({});
    expect(fleetFiltersToQuery(f)).toEqual({});
    expect(hasFleetFilters(f)).toBe(false);
    expect(hasFleetFilters({ ...f, op: true })).toBe(true);
  });

  it('builtByUser: built_by wins, created_by is the fallback', () => {
    expect(builtByUser({ built_by: 'u1', created_by: 'u2' }, 'u1')).toBe(true);
    expect(builtByUser({ built_by: 'u1', created_by: 'u2' }, 'u2')).toBe(false);
    expect(builtByUser({ built_by: null, created_by: 'u2' }, 'u2')).toBe(true);
    expect(builtByUser({ built_by: null, created_by: 'u2' }, null)).toBe(false);
  });

  it('filters by type, status, manufactured-by-me and operated-by-me', () => {
    const list = [
      AC({ id: 'a' }),
      AC({ id: 'b', type_id: 'type-caribou' }),
      AC({ id: 'c', status: 'retired' }),
      AC({ id: 'd', built_by: 'someone-else' }),
    ];
    const ctx = { userId: 'user-m', operatorOf: ['a', 'b'] };
    const ids = (f: Parameters<typeof filterAircraft>[1]) =>
      filterAircraft(list, f, ctx).map((a) => a.id);

    expect(ids(parseFleetFilters({ type: 'type-caribou' }))).toEqual(['b']);
    expect(ids(parseFleetFilters({ status: 'retired' }))).toEqual(['c']);
    expect(ids(parseFleetFilters({ mfg: '1' }))).toEqual(['a', 'b', 'c']);
    expect(ids(parseFleetFilters({ op: '1' }))).toEqual(['a', 'b']);
  });

  it('composes filters with AND', () => {
    const list = [
      AC({ id: 'a' }),
      AC({ id: 'b', status: 'retired' }),
      AC({ id: 'c', built_by: 'someone-else' }),
    ];
    const ctx = { userId: 'user-m', operatorOf: ['a', 'b', 'c'] };
    const f = parseFleetFilters({ status: 'active', mfg: '1', op: '1' });
    expect(filterAircraft(list, f, ctx).map((a) => a.id)).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// E2 — flight filters
// ---------------------------------------------------------------------------
const FL = (over: Partial<FlightFilterable> = {}): FlightFilterable => ({
  aircraft_id: 'ac-1',
  site_id: 'site-1',
  pilot_id: 'pilot-1',
  incident: 'none',
  started_at: '2026-08-10T12:00:00Z',
  flight_logs: [],
  ...over,
});

const CTX = {
  aircraftById: new Map([
    ['ac-1', { type_id: 'type-quiver', built_by: 'mfg-1', created_by: 'creator' }],
    ['ac-2', { type_id: 'type-caribou', built_by: null, created_by: 'creator' }],
  ]),
};

describe('flight filters (E2)', () => {
  it('round-trips through URL query params, dropping empties', () => {
    const f = parseFlightFilters({
      type: 'type-quiver',
      aircraft: 'ac-1',
      incident: 'crash',
      log: 'with',
      from: '2026-08-01',
      to: '2026-08-11',
    });
    expect(flightFiltersToQuery(f)).toEqual({
      type: 'type-quiver',
      aircraft: 'ac-1',
      incident: 'crash',
      log: 'with',
      from: '2026-08-01',
      to: '2026-08-11',
    });
    expect(parseFlightFilters(flightFiltersToQuery(f))).toEqual(f);
    expect(hasFlightFilters(f)).toBe(true);
    expect(hasFlightFilters(parseFlightFilters({}))).toBe(false);
  });

  it('coerces malformed params to "no filter" instead of throwing', () => {
    const f = parseFlightFilters({
      incident: 'exploded',
      log: 'maybe',
      from: '08/01/2026',
      to: 'not-a-date',
    });
    expect(f.incident).toBe('');
    expect(f.log).toBe('');
    expect(f.from).toBe('');
    expect(f.to).toBe('');
  });

  it('filters by aircraft type / specific aircraft / manufacturer via join', () => {
    const list = [FL(), FL({ aircraft_id: 'ac-2' }), FL({ aircraft_id: 'ac-unknown' })];
    expect(
      filterFlights(list, parseFlightFilters({ type: 'type-caribou' }), CTX),
    ).toEqual([list[1]]);
    expect(
      filterFlights(list, parseFlightFilters({ aircraft: 'ac-1' }), CTX),
    ).toEqual([list[0]]);
    // built_by wins; created_by is the fallback for aircraft without built_by
    expect(
      filterFlights(list, parseFlightFilters({ builder: 'mfg-1' }), CTX),
    ).toEqual([list[0]]);
    expect(
      filterFlights(list, parseFlightFilters({ builder: 'creator' }), CTX),
    ).toEqual([list[1]]);
    // unknown aircraft never matches an aircraft-join filter
    expect(
      filterFlights([list[2]], parseFlightFilters({ type: 'type-quiver' }), CTX),
    ).toEqual([]);
  });

  it('filters by site and pilot', () => {
    const list = [FL(), FL({ site_id: 'site-2' }), FL({ pilot_id: null })];
    expect(filterFlights(list, parseFlightFilters({ site: 'site-2' }), CTX)).toEqual([
      list[1],
    ]);
    expect(
      filterFlights(list, parseFlightFilters({ pilot: 'pilot-1' }), CTX),
    ).toEqual([list[0], list[1]]);
  });

  it('incident: exact value, "any", and "none" all behave', () => {
    const list = [
      FL(),
      FL({ incident: 'crash' }),
      FL({ incident: 'hard_landing' }),
    ];
    expect(
      filterFlights(list, parseFlightFilters({ incident: 'crash' }), CTX),
    ).toEqual([list[1]]);
    expect(
      filterFlights(list, parseFlightFilters({ incident: 'any' }), CTX),
    ).toEqual([list[1], list[2]]);
    expect(
      filterFlights(list, parseFlightFilters({ incident: 'none' }), CTX),
    ).toEqual([list[0]]);
  });

  it('has-log filter counts attached logs', () => {
    const withLog = FL({ flight_logs: [{ flight_log_summary: null }] });
    const without = FL({ flight_logs: [] });
    const missing = FL({ flight_logs: undefined });
    const list = [withLog, without, missing];
    expect(filterFlights(list, parseFlightFilters({ log: 'with' }), CTX)).toEqual([
      withLog,
    ]);
    expect(filterFlights(list, parseFlightFilters({ log: 'without' }), CTX)).toEqual([
      without,
      missing,
    ]);
  });

  it('date range uses the best start (parser start_time_utc wins) inclusively', () => {
    const early = FL({ started_at: '2026-08-01T12:00:00Z' });
    const late = FL({ started_at: '2026-08-20T12:00:00Z' });
    // hand-entered date is out of range, but the log clock is in range
    const logWins = FL({
      started_at: '2026-07-01T12:00:00Z',
      flight_logs: [
        { flight_log_summary: { start_time_utc: '2026-08-05T12:00:00Z' } },
      ],
    });
    const undated = FL({ started_at: null });
    const list = [early, late, logWins, undated];
    const f = parseFlightFilters({ from: '2026-08-01', to: '2026-08-10' });
    expect(filterFlights(list, f, CTX)).toEqual([early, logWins]);
    // open-ended ranges
    expect(
      filterFlights(list, parseFlightFilters({ from: '2026-08-15' }), CTX),
    ).toEqual([late]);
    expect(
      filterFlights(list, parseFlightFilters({ to: '2026-08-04' }), CTX),
    ).toEqual([early]);
  });

  it('composes all dimensions with AND', () => {
    const target = FL({ incident: 'crash', flight_logs: [{}] });
    const list = [
      target,
      FL({ incident: 'crash', aircraft_id: 'ac-2', flight_logs: [{}] }),
      FL({ flight_logs: [{}] }),
      FL({ incident: 'crash', flight_logs: [] }),
    ];
    const f = parseFlightFilters({
      type: 'type-quiver',
      incident: 'any',
      log: 'with',
      pilot: 'pilot-1',
      site: 'site-1',
      from: '2026-08-01',
      to: '2026-08-31',
    });
    expect(filterFlights(list, f, CTX)).toEqual([target]);
  });
});
