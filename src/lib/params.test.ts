import { describe, expect, it } from 'vitest';
import {
  activeHidePrefixes,
  addCustomPrefix,
  applyParamFilters,
  DEFAULT_HIDE_PREFIXES,
  defaultHideState,
  diffCounts,
  diffParams,
  fmtParamValue,
  HIDE_PREFIX_STORAGE_KEY,
  isHiddenBy,
  loadHideState,
  normalizePrefix,
  paramRows,
  prefixToggles,
  removeCustomPrefix,
  saveHideState,
  toggleHidePrefix,
  type HidePrefixState,
  type ParamMap,
} from './params';

// ---------------------------------------------------------------------------
// paramRows
// ---------------------------------------------------------------------------
describe('paramRows', () => {
  it('sorts by name and preserves values including null', () => {
    const map: ParamMap = { WPNAV_SPEED: 500, ATC_ANG_PIT_P: 4.5, BARO_ALT: null };
    expect(paramRows(map)).toEqual([
      { name: 'ATC_ANG_PIT_P', value: 4.5 },
      { name: 'BARO_ALT', value: null },
      { name: 'WPNAV_SPEED', value: 500 },
    ]);
  });

  it('handles empty maps', () => {
    expect(paramRows({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// diffParams (G2) — changed / added / removed / unchanged
// ---------------------------------------------------------------------------
describe('diffParams', () => {
  const a: ParamMap = {
    ATC_ANG_PIT_P: 4.5,
    WPNAV_SPEED: 500,
    OLD_ONLY: 1,
    SAME: 7,
  };
  const b: ParamMap = {
    ATC_ANG_PIT_P: 6.0, // changed
    WPNAV_SPEED: 500, // unchanged
    NEW_ONLY: 2, // added
    SAME: 7, // unchanged
  };

  it('classifies changed/added/removed/unchanged and sorts by name', () => {
    const rows = diffParams(a, b);
    expect(rows.map((r) => r.name)).toEqual([
      'ATC_ANG_PIT_P',
      'NEW_ONLY',
      'OLD_ONLY',
      'SAME',
      'WPNAV_SPEED',
    ]);
    expect(rows.find((r) => r.name === 'ATC_ANG_PIT_P')).toEqual({
      name: 'ATC_ANG_PIT_P',
      kind: 'changed',
      a: 4.5,
      b: 6.0,
    });
    expect(rows.find((r) => r.name === 'NEW_ONLY')).toEqual({
      name: 'NEW_ONLY',
      kind: 'added',
      a: undefined,
      b: 2,
    });
    expect(rows.find((r) => r.name === 'OLD_ONLY')).toEqual({
      name: 'OLD_ONLY',
      kind: 'removed',
      a: 1,
      b: undefined,
    });
    expect(rows.find((r) => r.name === 'SAME')?.kind).toBe('unchanged');
    expect(rows.find((r) => r.name === 'WPNAV_SPEED')?.kind).toBe('unchanged');
  });

  it('treats null values as values: null->number is changed, null->null unchanged', () => {
    const rows = diffParams({ P1: null, P2: null }, { P1: 1.5, P2: null });
    expect(rows.find((r) => r.name === 'P1')).toEqual({
      name: 'P1',
      kind: 'changed',
      a: null,
      b: 1.5,
    });
    expect(rows.find((r) => r.name === 'P2')?.kind).toBe('unchanged');
  });

  it('distinguishes absent (added/removed) from present-with-null', () => {
    const rows = diffParams({}, { P1: null });
    expect(rows[0]).toEqual({ name: 'P1', kind: 'added', a: undefined, b: null });
  });

  it('does not flag 0 vs -0 or float-identical values', () => {
    const rows = diffParams({ Z: 0, F: 0.5 }, { Z: 0, F: 0.5 });
    expect(rows.every((r) => r.kind === 'unchanged')).toBe(true);
  });

  it('handles empty snapshots', () => {
    expect(diffParams({}, {})).toEqual([]);
    expect(diffParams({ A: 1 }, {}).map((r) => r.kind)).toEqual(['removed']);
    expect(diffParams({}, { A: 1 }).map((r) => r.kind)).toEqual(['added']);
  });

  it('diffCounts tallies each kind', () => {
    expect(diffCounts(diffParams(a, b))).toEqual({
      changed: 1,
      added: 1,
      removed: 1,
      unchanged: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// filtering (G1 search + G3 prefix hides)
// ---------------------------------------------------------------------------
describe('applyParamFilters', () => {
  const rows = paramRows({
    COMPASS_OFS_X: 12,
    COMPASS_OFS_Y: -3,
    STAT_RUNTIME: 90210,
    ATC_ANG_PIT_P: 4.5,
    ATC_ANG_RLL_P: 4.5,
    WPNAV_SPEED: 500,
  });

  it('no search + no prefixes shows everything', () => {
    const r = applyParamFilters(rows, { search: '', hidePrefixes: [] });
    expect(r.visible).toHaveLength(6);
    expect(r.hiddenByPrefix).toBe(0);
    expect(r.hiddenBySearch).toBe(0);
    expect(r.total).toBe(6);
  });

  it('search is case-insensitive substring', () => {
    const r = applyParamFilters(rows, { search: 'atc_ang', hidePrefixes: [] });
    expect(r.visible.map((x) => x.name)).toEqual(['ATC_ANG_PIT_P', 'ATC_ANG_RLL_P']);
    expect(r.hiddenBySearch).toBe(4);
  });

  it('default prefixes hide COMPASS_* and STAT_* with a visible count', () => {
    const r = applyParamFilters(rows, {
      search: '',
      hidePrefixes: [...DEFAULT_HIDE_PREFIXES],
    });
    expect(r.visible.map((x) => x.name)).toEqual([
      'ATC_ANG_PIT_P',
      'ATC_ANG_RLL_P',
      'WPNAV_SPEED',
    ]);
    expect(r.hiddenByPrefix).toBe(3);
  });

  it('search matches hidden by a prefix are counted, not silently dropped', () => {
    const r = applyParamFilters(rows, {
      search: 'COMPASS_OFS',
      hidePrefixes: ['COMPASS_'],
    });
    expect(r.visible).toEqual([]);
    expect(r.hiddenByPrefix).toBe(2); // the user can see WHY the list is empty
    expect(r.hiddenBySearch).toBe(4);
  });

  it('prefix matching is case-insensitive and ignores empty prefixes', () => {
    expect(isHiddenBy('COMPASS_OFS_X', ['compass_'])).toBe(true);
    expect(isHiddenBy('COMPASS_OFS_X', [''])).toBe(false);
    expect(isHiddenBy('WPNAV_SPEED', ['COMPASS_'])).toBe(false);
  });

  it('works on diff rows too (shared name field)', () => {
    const diff = diffParams({ COMPASS_OFS_X: 1, WPNAV_SPEED: 500 }, { COMPASS_OFS_X: 2, WPNAV_SPEED: 600 });
    const r = applyParamFilters(diff, { search: '', hidePrefixes: ['COMPASS_'] });
    expect(r.visible.map((x) => x.name)).toEqual(['WPNAV_SPEED']);
    expect(r.hiddenByPrefix).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// hide-prefix state + persistence (G3)
// ---------------------------------------------------------------------------
function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    dump: () => Object.fromEntries(store),
  };
}

describe('hide-prefix state', () => {
  it('defaults: COMPASS_ and STAT_ active, no custom', () => {
    const s = defaultHideState();
    expect(activeHidePrefixes(s)).toEqual(['COMPASS_', 'STAT_']);
    expect(prefixToggles(s)).toEqual([
      { prefix: 'COMPASS_', enabled: true, builtin: true },
      { prefix: 'STAT_', enabled: true, builtin: true },
    ]);
  });

  it('toggling a default off removes it from active; toggling again restores', () => {
    let s = toggleHidePrefix(defaultHideState(), 'COMPASS_');
    expect(activeHidePrefixes(s)).toEqual(['STAT_']);
    s = toggleHidePrefix(s, 'COMPASS_');
    expect(activeHidePrefixes(s)).toEqual(['COMPASS_', 'STAT_']);
  });

  it('addCustomPrefix normalizes, dedupes, and ignores empties', () => {
    let s = addCustomPrefix(defaultHideState(), '  gps_ ');
    expect(s.custom).toEqual([{ prefix: 'GPS_', enabled: true }]);
    expect(activeHidePrefixes(s)).toContain('GPS_');
    s = addCustomPrefix(s, 'GPS_'); // dupe of custom
    expect(s.custom).toHaveLength(1);
    s = addCustomPrefix(s, 'compass_'); // dupe of a default
    expect(s.custom).toHaveLength(1);
    s = addCustomPrefix(s, '   '); // empty
    expect(s.custom).toHaveLength(1);
  });

  it('custom prefixes toggle and remove', () => {
    let s = addCustomPrefix(defaultHideState(), 'SERVO');
    s = toggleHidePrefix(s, 'SERVO');
    expect(s.custom).toEqual([{ prefix: 'SERVO', enabled: false }]);
    expect(activeHidePrefixes(s)).not.toContain('SERVO');
    s = removeCustomPrefix(s, 'SERVO');
    expect(s.custom).toEqual([]);
  });

  it('normalizePrefix uppercases and trims', () => {
    expect(normalizePrefix(' atc_ ')).toBe('ATC_');
  });

  it('save/load round-trips through storage', () => {
    const storage = fakeStorage();
    let s: HidePrefixState = addCustomPrefix(defaultHideState(), 'INS_');
    s = toggleHidePrefix(s, 'STAT_'); // default off
    saveHideState(s, storage);
    const loaded = loadHideState(storage);
    expect(loaded).toEqual(s);
    expect(activeHidePrefixes(loaded)).toEqual(['COMPASS_', 'INS_']);
  });

  it('load degrades to defaults on missing/corrupt/hostile data', () => {
    expect(loadHideState(fakeStorage())).toEqual(defaultHideState());
    expect(
      loadHideState(fakeStorage({ [HIDE_PREFIX_STORAGE_KEY]: 'not json{' })),
    ).toEqual(defaultHideState());
    expect(
      loadHideState(fakeStorage({ [HIDE_PREFIX_STORAGE_KEY]: '"just a string"' })),
    ).toEqual(defaultHideState());
    // junk entries are filtered, valid ones kept
    const mixed = loadHideState(
      fakeStorage({
        [HIDE_PREFIX_STORAGE_KEY]: JSON.stringify({
          disabledDefaults: ['STAT_', 'NOT_A_DEFAULT', 42],
          custom: [{ prefix: 'GPS_' }, { prefix: '' }, 'junk', null],
        }),
      }),
    );
    expect(mixed.disabledDefaults).toEqual(['STAT_']);
    expect(mixed.custom).toEqual([{ prefix: 'GPS_', enabled: true }]);
  });

  it('loadHideState/saveHideState tolerate absent storage', () => {
    expect(loadHideState(null)).toEqual(defaultHideState());
    expect(() => saveHideState(defaultHideState(), null)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// value formatting
// ---------------------------------------------------------------------------
describe('fmtParamValue', () => {
  it('renders null (non-finite in log) as em dash', () => {
    expect(fmtParamValue(null)).toBe('—');
    expect(fmtParamValue(undefined)).toBe('—');
  });

  it('renders integers without decimals', () => {
    expect(fmtParamValue(500)).toBe('500');
    expect(fmtParamValue(0)).toBe('0');
    expect(fmtParamValue(-3)).toBe('-3');
  });

  it('cleans float32 artifacts to 7 significant digits', () => {
    expect(fmtParamValue(0.30000001192092896)).toBe('0.3');
    expect(fmtParamValue(4.5)).toBe('4.5');
    expect(fmtParamValue(0.0025000000558793545)).toBe('0.0025');
  });
});
