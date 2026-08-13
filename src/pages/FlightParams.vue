<script setup lang="ts">
/**
 * /flights/:id/params — G: per-flight parameter browser + two-flight diff.
 *
 * - G1: browse/search every param from a parsed log's param_snapshots row
 *   (one jsonb map per log; fleet-visible under RLS).
 * - G2: pick any other flight (and log) to diff against: changed / added /
 *   removed with old → new values.
 * - G3: noise prefixes (COMPASS_*, STAT_* by default, plus user-defined)
 *   are hidden but ALWAYS counted in the toolbar — hidden is never
 *   silently missing. State persists in localStorage.
 *
 * 1000+ params render paginated (250/page) — no virtualization dependency.
 * Selections mirror into the URL query (log/vs/vslog) so views are
 * shareable, matching the filters convention on /flights.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppShell from '../components/AppShell.vue';
import AlertBanner from '../components/AlertBanner.vue';
import AppBadge from '../components/ui/AppBadge.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppTable from '../components/ui/AppTable.vue';
import { selectRows } from '../lib/db';
import { supabase } from '../lib/supabase';
import { fmtDateTime, pathBasename } from '../lib/format';
import { firstParam } from '../lib/filters';
import {
  activeHidePrefixes,
  addCustomPrefix,
  applyParamFilters,
  diffCounts,
  diffParams,
  fmtParamValue,
  loadHideState,
  paramRows,
  prefixToggles,
  removeCustomPrefix,
  paramFileContent,
  saveHideState,
  toggleHidePrefix,
  type ParamDiffRow,
  type ParamMap,
  type ParamRow,
} from '../lib/params';

const PAGE_SIZE = 250;

interface LogLite {
  id: string;
  object_path: string;
  status: string;
  uploaded_at: string;
}

interface FlightLite {
  id: string;
  title: string | null;
  started_at: string | null;
  aircraft: { serial: string; name: string | null } | null;
  flight_logs: LogLite[];
}

const route = useRoute();
const router = useRouter();
const flightId = computed(() => String(route.params.id));

const flight = ref<FlightLite | null>(null);
const allFlights = ref<FlightLite[]>([]);
const loading = ref(true);
const error = ref('');

// snapshot cache: log_id -> params map (null = no snapshot row exists)
const snapshots = ref(new Map<string, ParamMap | null>());

// --- selections (mirrored to URL query) ------------------------------------
const selLogId = ref('');
const vsFlightId = ref('');
const vsLogId = ref('');

// --- filters ---------------------------------------------------------------
const search = ref('');
const showUnchanged = ref(false);
const hideState = ref(loadHideState());
const newPrefix = ref('');
const page = ref(1);

function parsedLogsOf(f: FlightLite | null): LogLite[] {
  return (f?.flight_logs ?? [])
    .filter((l) => l.status === 'parsed')
    .sort((a, b) => a.uploaded_at.localeCompare(b.uploaded_at));
}

const parsedLogs = computed(() => parsedLogsOf(flight.value));

const vsCandidates = computed(() =>
  allFlights.value.filter((f) => f.id !== flightId.value && parsedLogsOf(f).length > 0),
);

const vsFlight = computed(
  () => vsCandidates.value.find((f) => f.id === vsFlightId.value) ?? null,
);
const vsParsedLogs = computed(() => parsedLogsOf(vsFlight.value));

const diffMode = computed(() => vsFlightId.value !== '' && vsLogId.value !== '');

function flightLabel(f: FlightLite): string {
  const craft = f.aircraft ? (f.aircraft.name || f.aircraft.serial) : '?';
  const when = f.started_at ? fmtDateTime(f.started_at) : 'no start time';
  return `${f.title || 'Flight'} · ${craft} · ${when}`;
}

function logLabel(l: LogLite): string {
  return `${pathBasename(l.object_path)} (${fmtDateTime(l.uploaded_at)})`;
}

// --- data loading ----------------------------------------------------------
async function ensureSnapshot(logId: string): Promise<void> {
  if (!logId || snapshots.value.has(logId)) return;
  const rows = await selectRows<{ log_id: string; params: ParamMap }[]>(
    supabase.from('param_snapshots').select('log_id,params').eq('log_id', logId).limit(1),
    'load param snapshot',
  );
  snapshots.value.set(logId, rows[0]?.params ?? null);
}

onMounted(async () => {
  try {
    // One list serves both the current-flight header and the diff picker.
    allFlights.value = await selectRows<FlightLite[]>(
      supabase
        .from('flights')
        .select('id,title,started_at,aircraft(serial,name),flight_logs(id,object_path,status,uploaded_at)')
        .order('started_at', { ascending: false, nullsFirst: false })
        .limit(500),
      'load flights',
    );
    flight.value = allFlights.value.find((f) => f.id === flightId.value) ?? null;
    if (!flight.value) {
      // Beyond the 500 most recent — fetch the one flight directly.
      const own = await selectRows<FlightLite[]>(
        supabase
          .from('flights')
          .select('id,title,started_at,aircraft(serial,name),flight_logs(id,object_path,status,uploaded_at)')
          .eq('id', flightId.value)
          .limit(1),
        'load flight',
      );
      flight.value = own[0] ?? null;
    }
    if (!flight.value) {
      error.value = 'Flight not found.';
      return;
    }

    // Initial selections from the URL, validated against real logs.
    const qLog = firstParam(route.query.log);
    selLogId.value = parsedLogs.value.some((l) => l.id === qLog)
      ? qLog
      : (parsedLogs.value[0]?.id ?? '');

    const qVs = firstParam(route.query.vs);
    if (vsCandidates.value.some((f) => f.id === qVs)) {
      vsFlightId.value = qVs;
      const qVsLog = firstParam(route.query.vslog);
      vsLogId.value = vsParsedLogs.value.some((l) => l.id === qVsLog)
        ? qVsLog
        : (vsParsedLogs.value[0]?.id ?? '');
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});

// Comparison flight changed via the picker: default to its first parsed log.
watch(vsFlightId, (id, old) => {
  if (id !== old && !vsParsedLogs.value.some((l) => l.id === vsLogId.value)) {
    vsLogId.value = vsParsedLogs.value[0]?.id ?? '';
  }
});

// Fetch snapshots lazily as selections change.
watch(
  [selLogId, vsLogId],
  ([a, b]) => {
    for (const id of [a, b]) {
      if (id) void ensureSnapshot(id).catch((e: unknown) => {
        error.value = e instanceof Error ? e.message : String(e);
      });
    }
  },
  { immediate: true },
);

// Mirror selections into the URL (replace — no history spam).
watch([selLogId, vsFlightId, vsLogId], ([log, vs, vslog]) => {
  const q: Record<string, string> = {};
  if (log && parsedLogs.value.length > 1) q.log = log;
  if (vs) q.vs = vs;
  if (vs && vslog && vsParsedLogs.value.length > 1) q.vslog = vslog;
  const current = { log: firstParam(route.query.log), vs: firstParam(route.query.vs), vslog: firstParam(route.query.vslog) };
  if (current.log !== (q.log ?? '') || current.vs !== (q.vs ?? '') || current.vslog !== (q.vslog ?? '')) {
    void router.replace({ query: q });
  }
});

// --- .param download -------------------------------------------------------
function downloadParamFile(): void {
  const map = paramsA.value;
  if (!map || !selLogId.value) return;
  const shortLog = selLogId.value.slice(0, 8);
  const content = paramFileContent(map, `flight ${flightId.value} log ${selLogId.value}`);
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `flight-${flightId.value.slice(0, 8)}-log-${shortLog}.param`;
  a.click();
  URL.revokeObjectURL(url);
}

// --- derived rows ----------------------------------------------------------
const paramsA = computed<ParamMap | null | undefined>(() =>
  selLogId.value ? snapshots.value.get(selLogId.value) : null,
);
const paramsB = computed<ParamMap | null | undefined>(() =>
  vsLogId.value ? snapshots.value.get(vsLogId.value) : null,
);

const snapshotLoading = computed(
  () =>
    (selLogId.value !== '' && paramsA.value === undefined) ||
    (diffMode.value && paramsB.value === undefined),
);

const browseRows = computed<ParamRow[]>(() =>
  paramsA.value ? paramRows(paramsA.value) : [],
);

const allDiffRows = computed<ParamDiffRow[]>(() =>
  paramsA.value && paramsB.value ? diffParams(paramsA.value, paramsB.value) : [],
);

const dCounts = computed(() => diffCounts(allDiffRows.value));

const hidePrefixes = computed(() => activeHidePrefixes(hideState.value));
const toggles = computed(() => prefixToggles(hideState.value));

const filtered = computed(() => {
  const rows: Array<ParamRow | ParamDiffRow> = diffMode.value
    ? showUnchanged.value
      ? allDiffRows.value
      : allDiffRows.value.filter((r) => r.kind !== 'unchanged')
    : browseRows.value;
  return applyParamFilters(rows, {
    search: search.value,
    hidePrefixes: hidePrefixes.value,
  });
});

const pageCount = computed(() =>
  Math.max(1, Math.ceil(filtered.value.visible.length / PAGE_SIZE)),
);
const pagedRows = computed(() => {
  const p = Math.min(page.value, pageCount.value);
  return filtered.value.visible.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
});

// Any change of scope resets to page 1.
watch([search, selLogId, vsFlightId, vsLogId, showUnchanged, hidePrefixes], () => {
  page.value = 1;
});

// --- filter mutations (persisted) ------------------------------------------
function mutateHideState(next: typeof hideState.value): void {
  hideState.value = next;
  saveHideState(next);
}

function onTogglePrefix(prefix: string): void {
  mutateHideState(toggleHidePrefix(hideState.value, prefix));
}

function onAddPrefix(): void {
  const next = addCustomPrefix(hideState.value, newPrefix.value);
  if (next !== hideState.value) {
    mutateHideState(next);
    newPrefix.value = '';
  }
}

function onRemovePrefix(prefix: string): void {
  mutateHideState(removeCustomPrefix(hideState.value, prefix));
}

// --- copy param name -------------------------------------------------------
const copied = ref('');
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copyName(name: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(name);
    copied.value = name;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied.value = ''), 1500);
  } catch {
    // clipboard unavailable (insecure context) — nothing to surface
  }
}

function kindVariant(kind: ParamDiffRow['kind']): 'warning' | 'success' | 'danger' | 'neutral' {
  return kind === 'changed'
    ? 'warning'
    : kind === 'added'
      ? 'success'
      : kind === 'removed'
        ? 'danger'
        : 'neutral';
}
</script>

<template>
  <AppShell
    :crumbs="[
      { label: 'Flights', to: '/flights' },
      { label: flight?.title ?? 'Flight', to: `/flights/${flightId}` },
      { label: 'Parameters' },
    ]"
  >
    <AlertBanner v-if="error" kind="error" :message="error" data-test="params-error" />
    <p v-if="loading">Loading parameters…</p>

    <template v-if="!loading && flight">
      <div class="page-header">
        <h1>Parameters</h1>
        <p class="page-header__description">
          {{ flightLabel(flight) }}
          <template v-if="diffMode"> — compared against {{ vsFlight ? flightLabel(vsFlight) : '' }}</template>
        </p>
      </div>

      <AlertBanner
        v-if="parsedLogs.length === 0"
        kind="info"
        message="No parsed logs on this flight yet — parameters appear once the parser finishes a log."
      />

      <template v-else>
        <!-- selectors -->
        <div class="pv-controls">
          <AppInput
            v-if="parsedLogs.length > 1"
            v-model="selLogId"
            as="select"
            label="Log"
            mono
            :options="parsedLogs.map((l) => ({ label: logLabel(l), value: l.id }))"
            data-test="param-log-select"
          />
          <AppInput
            v-model="vsFlightId"
            as="select"
            label="Diff against flight"
            :options="[
              { label: '— none (browse this log) —', value: '' },
              ...vsCandidates.map((f) => ({ label: flightLabel(f), value: f.id })),
            ]"
            data-test="param-vs-flight"
          />
          <AppInput
            v-if="vsParsedLogs.length > 1"
            v-model="vsLogId"
            as="select"
            label="Diff log"
            mono
            :options="vsParsedLogs.map((l) => ({ label: logLabel(l), value: l.id }))"
            data-test="param-vs-log"
          />
          <AppInput
            v-model="search"
            label="Search"
            placeholder="e.g. ATC_ANG or BATT"
            mono
            data-test="param-search"
          />
          <AppButton
            size="sm"
            variant="secondary"
            :disabled="!paramsA"
            title="Download this log's full parameter set as an ArduPilot .param file (hide filters do not apply)"
            data-test="param-download"
            @click="downloadParamFile"
          >
            Download .param
          </AppButton>
        </div>

        <!-- G3: prefix hide filters — always visible with counts -->
        <div class="pv-filters" data-test="param-hide-filters">
          <span class="pv-filters__label">Hide prefixes</span>
          <button
            v-for="t in toggles"
            :key="t.prefix"
            type="button"
            class="pv-chip"
            :class="{ 'pv-chip--on': t.enabled }"
            :title="t.enabled ? 'Hiding — click to show' : 'Not hiding — click to hide'"
            :data-test="`hide-prefix-${t.prefix}`"
            @click="onTogglePrefix(t.prefix)"
          >
            <span class="pv-chip__state">{{ t.enabled ? 'hide' : 'show' }}</span>
            {{ t.prefix }}*
            <span
              v-if="!t.builtin"
              class="pv-chip__x"
              title="Remove this filter"
              @click.stop="onRemovePrefix(t.prefix)"
            >×</span>
          </button>
          <form class="pv-addprefix" @submit.prevent="onAddPrefix">
            <input
              v-model="newPrefix"
              class="pv-addprefix__input"
              placeholder="Add prefix…"
              data-test="add-prefix-input"
            />
            <AppButton size="sm" variant="secondary" type="submit" :disabled="!newPrefix.trim()">
              Add
            </AppButton>
          </form>
          <label v-if="diffMode" class="pv-unchanged">
            <input v-model="showUnchanged" type="checkbox" data-test="show-unchanged" />
            show unchanged
          </label>
        </div>

        <!-- counts: hidden is never silently missing -->
        <p class="pv-counts mono-label" data-test="param-counts">
          <template v-if="snapshotLoading">Loading param snapshot…</template>
          <template v-else-if="!paramsA">No param snapshot stored for this log.</template>
          <template v-else-if="diffMode && !paramsB">
            No param snapshot stored for the comparison log — pick another flight/log.
          </template>
          <template v-else>
            <template v-if="diffMode">
              {{ dCounts.changed }} changed · {{ dCounts.added }} added ·
              {{ dCounts.removed }} removed · {{ dCounts.unchanged }} unchanged<template
                v-if="!showUnchanged"
              > (hidden)</template> —
            </template>
            showing {{ filtered.visible.length }} of {{ filtered.total }} rows<template
              v-if="filtered.hiddenByPrefix > 0"
            >, {{ filtered.hiddenByPrefix }} hidden by prefix filters</template><template
              v-if="filtered.hiddenBySearch > 0"
            >, {{ filtered.hiddenBySearch }} filtered by search</template>
          </template>
        </p>

        <!-- table -->
        <AppTable
          v-if="paramsA && !snapshotLoading && (!diffMode || paramsB)"
          data-test="param-table"
        >
          <thead>
            <tr v-if="diffMode">
              <th>Param</th>
              <th class="pv-th-kind">Change</th>
              <th class="pv-th-val">This flight</th>
              <th class="pv-th-val">Comparison</th>
            </tr>
            <tr v-else>
              <th>Param</th>
              <th class="pv-th-val">Value</th>
            </tr>
          </thead>
          <tbody>
            <template v-if="diffMode">
              <tr v-for="r in (pagedRows as ParamDiffRow[])" :key="r.name" :data-kind="r.kind">
                <td class="pv-name">
                  <span class="pv-name__text">{{ r.name }}</span>
                  <button
                    type="button"
                    class="pv-copy"
                    :title="`Copy ${r.name}`"
                    @click="copyName(r.name)"
                  >{{ copied === r.name ? 'copied' : 'copy' }}</button>
                </td>
                <td>
                  <AppBadge :variant="kindVariant(r.kind)" square>{{ r.kind }}</AppBadge>
                </td>
                <td class="pv-val" :class="{ 'pv-val--absent': r.a === undefined }">
                  {{ r.a === undefined ? 'absent' : fmtParamValue(r.a) }}
                </td>
                <td class="pv-val" :class="{ 'pv-val--absent': r.b === undefined }">
                  <template v-if="r.kind === 'changed'">
                    <span class="pv-val__arrow">→</span> {{ fmtParamValue(r.b) }}
                  </template>
                  <template v-else>{{ r.b === undefined ? 'absent' : fmtParamValue(r.b) }}</template>
                </td>
              </tr>
            </template>
            <template v-else>
              <tr v-for="r in (pagedRows as ParamRow[])" :key="r.name">
                <td class="pv-name">
                  <span class="pv-name__text">{{ r.name }}</span>
                  <button
                    type="button"
                    class="pv-copy"
                    :title="`Copy ${r.name}`"
                    @click="copyName(r.name)"
                  >{{ copied === r.name ? 'copied' : 'copy' }}</button>
                </td>
                <td class="pv-val">{{ fmtParamValue(r.value) }}</td>
              </tr>
            </template>
            <tr v-if="pagedRows.length === 0">
              <td :colspan="diffMode ? 4 : 2" class="pv-empty">
                No rows match — check the search text and the hide-prefix counts above.
              </td>
            </tr>
          </tbody>
        </AppTable>

        <!-- pager -->
        <div v-if="pageCount > 1" class="pv-pager" data-test="param-pager">
          <AppButton size="sm" variant="secondary" :disabled="page <= 1" @click="page -= 1">
            ← Prev
          </AppButton>
          <span class="mono-label">page {{ Math.min(page, pageCount) }} / {{ pageCount }}</span>
          <AppButton
            size="sm"
            variant="secondary"
            :disabled="page >= pageCount"
            @click="page += 1"
          >
            Next →
          </AppButton>
        </div>
      </template>
    </template>
  </AppShell>
</template>

<style scoped>
.pv-controls {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.75rem 1rem;
  margin-bottom: 0.75rem;
}

.pv-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.pv-filters__label {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--docs-primary);
}

.pv-chip {
  font-family: var(--font-mono);
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--docs-border, #e5e7eb);
  background: #fff;
  color: var(--docs-text);
  cursor: pointer;
}

.pv-chip--on {
  border-color: var(--docs-primary);
  background: var(--docs-primary);
  color: #fff;
}

.pv-chip__state {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  opacity: 0.7;
}

.pv-chip__x {
  padding: 0 0.15rem;
  font-weight: 700;
}

.pv-chip__x:hover {
  color: var(--status-danger, #b91c1c);
}

.pv-chip--on .pv-chip__x:hover {
  color: #ffd3d3;
}

.pv-addprefix {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.pv-addprefix__input {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--docs-border, #e5e7eb);
  width: 9rem;
  text-transform: uppercase;
}

.pv-unchanged {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 13px;
  margin-left: auto;
  cursor: pointer;
}

.pv-counts {
  margin: 0.25rem 0 0.75rem;
}

.pv-name {
  white-space: nowrap;
}

.pv-name__text {
  font-family: var(--font-mono);
  font-size: 13px;
}

.pv-copy {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-left: 0.5rem;
  padding: 0.05rem 0.3rem;
  border: 1px solid var(--docs-border, #e5e7eb);
  background: #fff;
  color: var(--docs-muted, #6b7280);
  cursor: pointer;
  opacity: 0;
}

tr:hover .pv-copy,
.pv-copy:focus-visible {
  opacity: 1;
}

.pv-val {
  font-family: var(--font-mono);
  font-size: 13px;
  white-space: nowrap;
}

.pv-val--absent {
  color: var(--docs-muted, #9ca3af);
  font-style: italic;
}

.pv-val__arrow {
  color: var(--docs-muted, #9ca3af);
  margin-right: 0.25rem;
}

.pv-empty {
  color: var(--docs-muted, #6b7280);
  text-align: center;
}

.pv-pager {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.75rem;
}
</style>
