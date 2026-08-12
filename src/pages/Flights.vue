<script setup lang="ts">
/**
 * /flights — all flights (fleet-visible reads), with per-flight log status
 * rollup. Rows open the flight card.
 *
 * E2: composable (AND) filters for engineers studying fleet data —
 * aircraft type / specific aircraft / site / manufacturer / incident /
 * pilot / has-log / date range — mirrored into URL query params so a
 * filtered view is a shareable link. Filtering is client-side over the
 * same ≤200-row window the table already loads.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppShell from '../components/AppShell.vue';
import AppBadge from '../components/ui/AppBadge.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppTable from '../components/ui/AppTable.vue';
import type { TableColumn } from '../components/ui/AppTable.vue';
import AlertBanner from '../components/AlertBanner.vue';
import {
  selectRows,
  type Flight,
  type FlightLogStatus,
  type Profile,
  type Site,
} from '../lib/db';
import {
  builtByUser,
  filterFlights,
  flightFiltersToQuery,
  hasFlightFilters,
  parseFlightFilters,
  sameQuery,
  type AircraftFacts,
} from '../lib/filters';
import { supabase } from '../lib/supabase';
import { fmtDateTime, fmtDuration } from '../lib/format';
import { flightDurationS, flightStartIso, type LogWithSummary } from '../lib/flightMetrics';

interface FlightRow extends Flight {
  aircraft?: { serial: string; name: string | null } | null;
  sites?: { name: string } | null;
  user_profiles?: { name: string | null } | null;
  flight_logs?: ({ id: string; status: FlightLogStatus } & LogWithSummary)[];
}

interface AircraftLite extends AircraftFacts {
  id: string;
  serial: string;
  name: string | null;
  aircraft_types?: { id: string; name: string } | null;
}

const route = useRoute();
const router = useRouter();
const flights = ref<FlightRow[]>([]);
const aircraftList = ref<AircraftLite[]>([]);
const siteList = ref<Pick<Site, 'id' | 'name'>[]>([]);
const profiles = ref<Pick<Profile, 'id' | 'name'>[]>([]);
const loading = ref(true);
const error = ref('');
// P3: one-shot success notice handed over via ?notice= (e.g. after a flight
// delete, whose page is gone). Captured on mount, then stripped from the URL
// so the filter<->query sync below owns the query string again.
const notice = ref(typeof route.query.notice === 'string' ? route.query.notice : '');

function flightsQuery(summaryCols: string) {
  return supabase
    .from('flights')
    .select(
      `*, aircraft(serial,name), sites(name), user_profiles!flights_pilot_id_fkey(name), flight_logs(id,status,flight_log_summary(${summaryCols}))`,
    )
    .order('started_at', { ascending: false, nullsFirst: false })
    .limit(200);
}

async function loadFlights() {
  try {
    flights.value = await selectRows<FlightRow[]>(
      flightsQuery('duration_s,start_time_utc'),
      'load flights',
    );
  } catch (e) {
    // Deploy-ordering guard: start_time_utc lands in migration
    // 20260811120000_v21_summary_takeoff_start_incident.sql. If the
    // frontend deploys before that migration is applied, the named
    // column 42703s — fall back to duration_s only so /flights still
    // renders (start column shows the hand-entered time meanwhile).
    if (e instanceof Error && e.message.includes('start_time_utc')) {
      flights.value = await selectRows<FlightRow[]>(
        flightsQuery('duration_s'),
        'load flights',
      );
    } else {
      throw e;
    }
  }
}

onMounted(async () => {
  if (notice.value) {
    const { notice: _drop, ...rest } = route.query;
    void router.replace({ query: rest });
  }
  try {
    await Promise.all([
      loadFlights(),
      selectRows<AircraftLite[]>(
        supabase
          .from('aircraft')
          .select('id,serial,name,type_id,built_by,created_by,aircraft_types(id,name)')
          .order('serial'),
        'load aircraft',
      ).then((rows) => (aircraftList.value = rows)),
      selectRows<typeof siteList.value>(
        supabase.from('sites').select('id,name').order('name'),
        'load sites',
      ).then((rows) => (siteList.value = rows)),
      selectRows<typeof profiles.value>(
        supabase.from('user_profiles').select('id,name').order('name'),
        'load profiles',
      ).then((rows) => (profiles.value = rows)),
    ]);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});

// --- E2: filters <-> URL query params --------------------------------------
const filters = ref(parseFlightFilters(route.query));

watch(
  filters,
  (f) => {
    const q = flightFiltersToQuery(f);
    if (!sameQuery(q, route.query as Record<string, unknown>)) {
      void router.replace({ query: q });
    }
  },
  { deep: true },
);

// back/forward navigation (and shared links) update the controls
watch(
  () => route.query,
  (q) => {
    const parsed = parseFlightFilters(q);
    if (JSON.stringify(parsed) !== JSON.stringify(filters.value)) {
      filters.value = parsed;
    }
  },
);

function clearFilters() {
  filters.value = parseFlightFilters({});
}

const filtersActive = computed(() => hasFlightFilters(filters.value));

const aircraftById = computed(() => {
  const m = new Map<string, AircraftFacts>();
  for (const a of aircraftList.value) {
    m.set(a.id, { type_id: a.type_id, built_by: a.built_by, created_by: a.created_by });
  }
  return m;
});

const profileName = computed(() => {
  const m = new Map<string, string>();
  for (const p of profiles.value) m.set(p.id, p.name ?? p.id.slice(0, 8));
  return m;
});

const typeOptions = computed(() => {
  const seen = new Map<string, string>();
  for (const a of aircraftList.value) {
    if (a.aircraft_types) seen.set(a.type_id, a.aircraft_types.name);
  }
  return [
    { label: 'All types', value: '' },
    ...[...seen.entries()]
      .sort((x, y) => x[1].localeCompare(y[1]))
      .map(([value, label]) => ({ label, value })),
  ];
});

const aircraftOptions = computed(() => [
  { label: 'All aircraft', value: '' },
  ...aircraftList.value.map((a) => ({
    label: a.name ? `${a.name} (${a.serial})` : a.serial,
    value: a.id,
  })),
]);

const siteOptions = computed(() => [
  { label: 'All sites', value: '' },
  ...siteList.value.map((s) => ({ label: s.name, value: s.id })),
]);

/** Manufacturers = users appearing as effective builder of any aircraft. */
const builderOptions = computed(() => {
  const ids = new Set<string>();
  for (const a of aircraftList.value) ids.add(a.built_by ?? a.created_by);
  return [
    { label: 'All manufacturers', value: '' },
    ...[...ids]
      .map((id) => ({ label: profileName.value.get(id) ?? id.slice(0, 8), value: id }))
      .sort((x, y) => x.label.localeCompare(y.label)),
  ];
});

const pilotOptions = computed(() => [
  { label: 'All pilots', value: '' },
  ...profiles.value.map((p) => ({ label: p.name ?? p.id.slice(0, 8), value: p.id })),
]);

const incidentOptions = [
  { label: 'All flights', value: '' },
  { label: 'Any incident', value: 'any' },
  { label: 'No incident', value: 'none' },
  { label: 'crash', value: 'crash' },
  { label: 'hard landing', value: 'hard_landing' },
  { label: 'systems', value: 'systems' },
  { label: 'other', value: 'other' },
];

const logOptions = [
  { label: 'With or without logs', value: '' },
  { label: 'With logs', value: 'with' },
  { label: 'Without logs', value: 'without' },
];

const visibleFlights = computed(() =>
  filterFlights(flights.value, filters.value, { aircraftById: aircraftById.value }),
);

// --- table -----------------------------------------------------------------
const columns: TableColumn[] = [
  { key: 'started_at', label: 'Start', width: '170px', mono: true },
  { key: 'aircraft', label: 'Aircraft' },
  { key: 'title', label: 'Title' },
  { key: 'pilot', label: 'Pilot', width: '140px' },
  { key: 'site', label: 'Site', width: '160px' },
  { key: 'duration', label: 'Duration', width: '100px', align: 'right', mono: true },
  { key: 'logs', label: 'Logs', width: '130px' },
  { key: 'gps', label: 'GPS', width: '90px' },
];

/** Worst-first rollup of a flight's log statuses. */
function logRollup(logs: { status: FlightLogStatus }[] | undefined): {
  label: string;
  status: FlightLogStatus | null;
} {
  if (!logs || logs.length === 0) return { label: 'no log', status: null };
  const order: FlightLogStatus[] = ['error', 'parsing', 'uploaded', 'parsed'];
  for (const s of order) {
    if (logs.some((l) => l.status === s)) {
      return { label: logs.length > 1 ? `${s} (${logs.length})` : s, status: s };
    }
  }
  return { label: 'no log', status: null };
}

const rows = computed(() =>
  visibleFlights.value.map((f) => {
    const roll = logRollup(f.flight_logs);
    return {
      id: f.id,
      // F3: log-derived start_time_utc wins over the hand-entered time
      started_at: fmtDateTime(flightStartIso(f.flight_logs, f.started_at)),
      aircraft: f.aircraft ? f.aircraft.name || f.aircraft.serial : '—',
      title: f.title ?? '(untitled)',
      // E2: surface the incident flag in the table (badge in title cell)
      incident: f.incident !== 'none' ? f.incident : null,
      pilot: f.user_profiles?.name ?? '—',
      site: f.sites?.name ?? '—',
      // E1: parsed summary duration_s wins; ended-started is only a fallback
      duration: fmtDuration(flightDurationS(f.flight_logs, f.started_at, f.ended_at)),
      logs: roll.label,
      logStatus: roll.status,
      gps: f.gps_private ? 'private' : 'shared',
    };
  }),
);
</script>

<template>
  <AppShell :crumbs="[{ label: 'Flights' }, { label: 'All flights' }]">
    <div class="page-header">
      <h1>Flights</h1>
      <p class="page-header__description">
        Fleet-visible flight record — every flight, every aircraft, newest
        first.
      </p>
    </div>

    <AlertBanner v-if="error" kind="error" :message="error" />
    <AlertBanner v-if="notice" kind="success" :message="notice" data-test="flights-notice" />

    <div class="flights-actions">
      <AppButton to="/flights/new">+ Quick log</AppButton>
      <AppButton to="/upload" variant="secondary">Bulk upload</AppButton>
    </div>

    <!-- E2: composable filters (AND), shareable via the URL -->
    <div class="filter-bar" data-test="flight-filters">
      <AppInput v-model="filters.type" as="select" label="Type" :options="typeOptions" />
      <AppInput
        v-model="filters.aircraft"
        as="select"
        label="Aircraft"
        :options="aircraftOptions"
      />
      <AppInput v-model="filters.site" as="select" label="Site" :options="siteOptions" />
      <AppInput
        v-model="filters.builder"
        as="select"
        label="Manufacturer"
        :options="builderOptions"
      />
      <AppInput
        v-model="filters.incident"
        as="select"
        label="Incident"
        :options="incidentOptions"
      />
      <AppInput v-model="filters.pilot" as="select" label="Pilot" :options="pilotOptions" />
      <AppInput v-model="filters.log" as="select" label="Logs" :options="logOptions" />
      <AppInput v-model="filters.from" label="From" type="date" mono />
      <AppInput v-model="filters.to" label="To" type="date" mono />
      <div class="filter-bar__tail">
        <span class="filter-bar__count" data-test="flights-count">
          {{ visibleFlights.length }} of {{ flights.length }} shown
        </span>
        <AppButton
          v-if="filtersActive"
          size="sm"
          variant="ghost"
          data-test="clear-filters"
          @click="clearFilters"
        >
          Clear filters
        </AppButton>
      </div>
    </div>

    <p v-if="loading">Loading flights…</p>
    <AppTable
      v-else
      :columns="columns"
      :rows="rows"
      row-key="id"
      clickable
      :empty-text="
        filtersActive
          ? 'No flights match the current filters.'
          : 'No flights logged yet — use Quick log or Bulk upload.'
      "
      @row-click="(row) => router.push(`/flights/${row.id}`)"
    >
      <template #cell-title="{ row, value }">
        {{ value }}
        <AppBadge v-if="row.incident" variant="danger" square dot>
          {{ String(row.incident).replace('_', ' ') }}
        </AppBadge>
      </template>
      <template #cell-logs="{ row, value }">
        <AppBadge v-if="row.logStatus" :status="row.logStatus as any" square dot>{{ value }}</AppBadge>
        <span v-else class="no-log">{{ value }}</span>
      </template>
      <template #cell-gps="{ value }">
        <AppBadge :variant="value === 'private' ? 'neutral' : 'success'">{{ value }}</AppBadge>
      </template>
    </AppTable>
  </AppShell>
</template>

<style scoped>
.flights-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.no-log {
  color: var(--docs-text-muted);
  font-style: italic;
}

/* E2 filter bar */
.filter-bar {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 0.75rem 1rem;
  border: 1px solid var(--docs-border, #d0d9f3);
  background: var(--docs-bg-subtle, #f7f8fa);
  padding: 0.75rem 1rem;
  margin-bottom: 1.25rem;
}

.filter-bar > .field {
  min-width: 150px;
  max-width: 220px;
  flex: 0 1 auto;
}

.filter-bar__tail {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-left: auto;
  padding-bottom: 0.35rem;
}

.filter-bar__count {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--docs-text-muted);
}
</style>
