/**
 * G — param viewer/diff logic, kept pure (no Vue, no Supabase) so it
 * unit-tests directly.
 *
 * Data shape (verified against parser + schema, ARCH-NOTES-V21 §2):
 * `param_snapshots.params` is ONE jsonb object per log mapping
 * PARAM_NAME -> number | null (summary.py PARM handler none-ifies
 * non-finite floats before insert, so NaN/Inf never appear).
 *
 * Noise filters (G3): COMPASS_* (per-boot compass calibration) and STAT_*
 * (monotonic runtime counters) are hidden by default; users can toggle
 * those and add their own prefixes. State persists in localStorage.
 * The UI must always surface hidden COUNTS so hidden ≠ silently missing.
 */

export type ParamMap = Record<string, number | null>;

export interface ParamRow {
  name: string;
  value: number | null;
}

// ---------------------------------------------------------------------------
// Browse rows
// ---------------------------------------------------------------------------

/** ParamMap -> name-sorted rows for the browser table. */
export function paramRows(map: ParamMap): ParamRow[] {
  return Object.keys(map)
    .sort()
    .map((name) => ({ name, value: map[name] ?? null }));
}

// ---------------------------------------------------------------------------
// Diff (G2)
// ---------------------------------------------------------------------------

export type DiffKind = 'changed' | 'added' | 'removed' | 'unchanged';

export interface ParamDiffRow {
  name: string;
  kind: DiffKind;
  /** value in log A; undefined = param absent from A */
  a: number | null | undefined;
  /** value in log B; undefined = param absent from B */
  b: number | null | undefined;
}

/**
 * Diff two snapshots, A -> B. 'added' = only in B, 'removed' = only in A,
 * 'changed' = present in both with different values (null counts as a
 * value: null -> 1.5 is 'changed', null -> null is 'unchanged').
 * Rows come back name-sorted and INCLUDE unchanged rows — callers filter
 * by kind so the "show unchanged" toggle costs nothing.
 */
export function diffParams(a: ParamMap, b: ParamMap): ParamDiffRow[] {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  const rows: ParamDiffRow[] = [];
  for (const name of [...names].sort()) {
    const inA = Object.prototype.hasOwnProperty.call(a, name);
    const inB = Object.prototype.hasOwnProperty.call(b, name);
    const av = inA ? (a[name] ?? null) : undefined;
    const bv = inB ? (b[name] ?? null) : undefined;
    let kind: DiffKind;
    if (inA && !inB) kind = 'removed';
    else if (!inA && inB) kind = 'added';
    else kind = Object.is(av, bv) ? 'unchanged' : 'changed';
    rows.push({ name, kind, a: av, b: bv });
  }
  return rows;
}

export interface DiffCounts {
  changed: number;
  added: number;
  removed: number;
  unchanged: number;
}

export function diffCounts(rows: ParamDiffRow[]): DiffCounts {
  const c: DiffCounts = { changed: 0, added: 0, removed: 0, unchanged: 0 };
  for (const r of rows) c[r.kind] += 1;
  return c;
}

// ---------------------------------------------------------------------------
// Search + prefix-hide filtering (G1/G3)
// ---------------------------------------------------------------------------

export interface ParamFilter {
  /** case-insensitive substring on the param name; '' = no search */
  search: string;
  /** active hide prefixes (uppercase); matching rows are hidden */
  hidePrefixes: string[];
}

export interface FilterResult<T> {
  visible: T[];
  /** rows that matched the search but were hidden by a prefix filter */
  hiddenByPrefix: number;
  /** rows excluded by the search text alone */
  hiddenBySearch: number;
  total: number;
}

/** True when `name` starts with any of `prefixes` (case-insensitive). */
export function isHiddenBy(name: string, prefixes: string[]): boolean {
  const upper = name.toUpperCase();
  return prefixes.some((p) => p !== '' && upper.startsWith(p.toUpperCase()));
}

/**
 * Search first, then prefix-hide within the matches — so a user searching
 * "COMPASS_OFS" with COMPASS_ hidden sees "N hidden by filters", not an
 * empty list that looks like the params don't exist.
 */
export function applyParamFilters<T extends { name: string }>(
  rows: T[],
  filter: ParamFilter,
): FilterResult<T> {
  const needle = filter.search.trim().toUpperCase();
  const matches =
    needle === '' ? rows : rows.filter((r) => r.name.toUpperCase().includes(needle));
  const visible = matches.filter((r) => !isHiddenBy(r.name, filter.hidePrefixes));
  return {
    visible,
    hiddenByPrefix: matches.length - visible.length,
    hiddenBySearch: rows.length - matches.length,
    total: rows.length,
  };
}

// ---------------------------------------------------------------------------
// Hide-prefix state + localStorage persistence (G3)
// ---------------------------------------------------------------------------

export const DEFAULT_HIDE_PREFIXES: readonly string[] = ['COMPASS_', 'STAT_'];

export interface CustomPrefix {
  prefix: string;
  enabled: boolean;
}

export interface HidePrefixState {
  /** built-in default prefixes the user has toggled OFF */
  disabledDefaults: string[];
  /** user-added prefixes, each individually toggleable */
  custom: CustomPrefix[];
}

export interface PrefixToggle {
  prefix: string;
  enabled: boolean;
  builtin: boolean;
}

export const HIDE_PREFIX_STORAGE_KEY = 'ft.paramHidePrefixes.v1';

export function defaultHideState(): HidePrefixState {
  return { disabledDefaults: [], custom: [] };
}

/** All prefixes for display, defaults first, with their on/off state. */
export function prefixToggles(state: HidePrefixState): PrefixToggle[] {
  return [
    ...DEFAULT_HIDE_PREFIXES.map((p) => ({
      prefix: p,
      enabled: !state.disabledDefaults.includes(p),
      builtin: true,
    })),
    ...state.custom.map((c) => ({ prefix: c.prefix, enabled: c.enabled, builtin: false })),
  ];
}

/** The currently-active hide prefixes (feed into applyParamFilters). */
export function activeHidePrefixes(state: HidePrefixState): string[] {
  return prefixToggles(state)
    .filter((t) => t.enabled)
    .map((t) => t.prefix);
}

/** Toggle one prefix on/off (built-in or custom). Returns a new state. */
export function toggleHidePrefix(state: HidePrefixState, prefix: string): HidePrefixState {
  if ((DEFAULT_HIDE_PREFIXES as readonly string[]).includes(prefix)) {
    const off = state.disabledDefaults.includes(prefix);
    return {
      ...state,
      disabledDefaults: off
        ? state.disabledDefaults.filter((p) => p !== prefix)
        : [...state.disabledDefaults, prefix],
    };
  }
  return {
    ...state,
    custom: state.custom.map((c) =>
      c.prefix === prefix ? { ...c, enabled: !c.enabled } : c,
    ),
  };
}

/** Normalize a user-typed prefix: trim + uppercase (param names are UPPER). */
export function normalizePrefix(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Add a user prefix (normalized, enabled). No-op on empty input or a
 * duplicate of a default/custom prefix. Returns a new state.
 */
export function addCustomPrefix(state: HidePrefixState, raw: string): HidePrefixState {
  const prefix = normalizePrefix(raw);
  if (prefix === '') return state;
  if ((DEFAULT_HIDE_PREFIXES as readonly string[]).includes(prefix)) return state;
  if (state.custom.some((c) => c.prefix === prefix)) return state;
  return { ...state, custom: [...state.custom, { prefix, enabled: true }] };
}

export function removeCustomPrefix(state: HidePrefixState, prefix: string): HidePrefixState {
  return { ...state, custom: state.custom.filter((c) => c.prefix !== prefix) };
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // SSR / privacy modes that throw on access
  }
}

/** Load persisted state; malformed/missing data degrades to defaults. */
export function loadHideState(storage: StorageLike | null = defaultStorage()): HidePrefixState {
  if (!storage) return defaultHideState();
  try {
    const raw = storage.getItem(HIDE_PREFIX_STORAGE_KEY);
    if (!raw) return defaultHideState();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return defaultHideState();
    const p = parsed as Record<string, unknown>;
    const disabledDefaults = Array.isArray(p.disabledDefaults)
      ? p.disabledDefaults.filter(
          (x): x is string =>
            typeof x === 'string' && (DEFAULT_HIDE_PREFIXES as readonly string[]).includes(x),
        )
      : [];
    const custom = Array.isArray(p.custom)
      ? p.custom
          .filter(
            (x): x is { prefix: string; enabled?: unknown } =>
              typeof x === 'object' &&
              x !== null &&
              typeof (x as Record<string, unknown>).prefix === 'string' &&
              (x as Record<string, unknown>).prefix !== '',
          )
          .map((x) => ({ prefix: x.prefix, enabled: x.enabled !== false }))
      : [];
    return { disabledDefaults, custom };
  } catch {
    return defaultHideState();
  }
}

/** Persist state; storage failures (quota, private mode) are swallowed. */
export function saveHideState(
  state: HidePrefixState,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(HIDE_PREFIX_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // non-fatal: filters just won't persist
  }
}

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

/**
 * Param values are float32 in the log, so JS sees artifacts like
 * 0.30000001192092896. 7 significant digits round-trips float32 cleanly
 * without inventing precision. null (non-finite in log) renders as '—'.
 */
export function fmtParamValue(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return String(Number(v.toPrecision(7)));
}
