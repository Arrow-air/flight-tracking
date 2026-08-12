<script setup lang="ts">
/**
 * / — fleet list: aircraft cards with type, status and derived stats
 * (flight count + hours from flights / parsed log summaries).
 * "New aircraft" only for manufacturers/admins (RLS invariant 1).
 *
 * C2: composable (AND) filters — type / status / manufactured-by-me /
 * operated-by-me — mirrored into URL query params so filtered views are
 * shareable links.
 * C3: "total flight hours across all Quiver airframes" lives here as a
 * fleet-header stat (chosen home: the fleet page is where per-airframe
 * hours already roll up). It is computed over the WHOLE fleet, not the
 * filtered subset.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppShell from '../components/AppShell.vue';
import AppBadge from '../components/ui/AppBadge.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppCard from '../components/ui/AppCard.vue';
import AppInput from '../components/ui/AppInput.vue';
import AlertBanner from '../components/AlertBanner.vue';
import { auth, isAdmin, isManufacturer, userId } from '../lib/auth';
import { selectRows, type Aircraft, type Flight } from '../lib/db';
import {
  filterAircraft,
  fleetFiltersToQuery,
  hasFleetFilters,
  parseFleetFilters,
  sameQuery,
} from '../lib/filters';
import { supabase } from '../lib/supabase';
import { fmtHours } from '../lib/format';

interface LogDuration {
  flight_id: string;
  flight_log_summary: { duration_s: number | null } | { duration_s: number | null }[] | null;
}

const route = useRoute();
const router = useRouter();

const aircraft = ref<Aircraft[]>([]);
const flights = ref<Pick<Flight, 'id' | 'aircraft_id' | 'started_at' | 'ended_at'>[]>([]);
const logDurations = ref<LogDuration[]>([]);
const loading = ref(true);
const error = ref('');

const statusVariant: Record<string, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  maintenance: 'warning',
  retired: 'neutral',
};

onMounted(async () => {
  try {
    const [ac, fl, ld] = await Promise.all([
      selectRows<Aircraft[]>(
        supabase
          .from('aircraft')
          .select('*, aircraft_types(id,name,class,cells)')
          .order('serial'),
        'load aircraft',
      ),
      selectRows<typeof flights.value>(
        supabase.from('flights').select('id, aircraft_id, started_at, ended_at'),
        'load flights',
      ),
      selectRows<LogDuration[]>(
        supabase.from('flight_logs').select('flight_id, flight_log_summary(duration_s)'),
        'load log summaries',
      ),
    ]);
    aircraft.value = ac;
    flights.value = fl;
    logDurations.value = ld;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});

// --- C2: filters <-> URL query params --------------------------------------
const filters = ref(parseFleetFilters(route.query));

watch(
  filters,
  (f) => {
    const q = fleetFiltersToQuery(f);
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
    const parsed = parseFleetFilters(q);
    if (JSON.stringify(parsed) !== JSON.stringify(filters.value)) {
      filters.value = parsed;
    }
  },
);

function clearFilters() {
  filters.value = parseFleetFilters({});
}

const filtersActive = computed(() => hasFleetFilters(filters.value));

const typeOptions = computed(() => {
  const seen = new Map<string, string>();
  for (const a of aircraft.value) {
    if (a.aircraft_types) seen.set(a.type_id, a.aircraft_types.name);
  }
  return [
    { label: 'All types', value: '' },
    ...[...seen.entries()]
      .sort((x, y) => x[1].localeCompare(y[1]))
      .map(([value, label]) => ({ label, value })),
  ];
});

const statusOptions = [
  { label: 'All statuses', value: '' },
  { label: 'active', value: 'active' },
  { label: 'maintenance', value: 'maintenance' },
  { label: 'retired', value: 'retired' },
];

const visibleAircraft = computed(() =>
  filterAircraft(aircraft.value, filters.value, {
    userId: userId.value,
    operatorOf: auth.operatorOf,
  }),
);

// --- stats -----------------------------------------------------------------
const stats = computed(() => {
  // best duration per flight: parsed summary wins, else ended-started
  const summaryByFlight = new Map<string, number>();
  for (const row of logDurations.value) {
    const s = Array.isArray(row.flight_log_summary)
      ? row.flight_log_summary[0]
      : row.flight_log_summary;
    if (s?.duration_s != null) {
      summaryByFlight.set(
        row.flight_id,
        (summaryByFlight.get(row.flight_id) ?? 0) + s.duration_s,
      );
    }
  }
  const byAircraft = new Map<string, { count: number; seconds: number }>();
  for (const f of flights.value) {
    const entry = byAircraft.get(f.aircraft_id) ?? { count: 0, seconds: 0 };
    entry.count += 1;
    const fromSummary = summaryByFlight.get(f.id);
    if (fromSummary != null) {
      entry.seconds += fromSummary;
    } else if (f.started_at && f.ended_at) {
      entry.seconds +=
        (new Date(f.ended_at).getTime() - new Date(f.started_at).getTime()) / 1000;
    }
    byAircraft.set(f.aircraft_id, entry);
  }
  return byAircraft;
});

function statFor(id: string): string {
  const s = stats.value.get(id);
  if (!s || s.count === 0) return 'No flights logged.';
  return `${s.count} flight${s.count === 1 ? '' : 's'}, ${fmtHours(s.seconds)} total.`;
}

// C3: whole-fleet Quiver rollup (same summary-first math as the cards)
const quiverStat = computed(() => {
  const quiver = aircraft.value.filter((a) => a.aircraft_types?.name === 'Quiver');
  let seconds = 0;
  for (const a of quiver) seconds += stats.value.get(a.id)?.seconds ?? 0;
  return { airframes: quiver.length, seconds };
});
</script>

<template>
  <AppShell :crumbs="[{ label: 'Fleet' }, { label: 'Aircraft' }]">
    <div class="page-header">
      <h1>Fleet</h1>
      <p class="page-header__description">
        Every open-stack aircraft on record — registry, status and cumulative
        flight time.
      </p>
    </div>

    <AlertBanner v-if="error" kind="error" :message="error" />

    <div v-if="!loading" class="fleet-stat" data-test="quiver-hours">
      <span class="fleet-stat__label">Quiver fleet total</span>
      <span class="fleet-stat__value">
        {{ quiverStat.airframes > 0 ? fmtHours(quiverStat.seconds) : '—' }}
      </span>
      <span class="fleet-stat__detail">
        across {{ quiverStat.airframes }} Quiver
        airframe{{ quiverStat.airframes === 1 ? '' : 's' }}
      </span>
    </div>

    <div v-if="isManufacturer || isAdmin" class="fleet-actions">
      <AppButton to="/aircraft/new" data-test="new-aircraft">+ New aircraft</AppButton>
    </div>

    <!-- C2: composable filters (AND), shareable via the URL -->
    <div class="filter-bar" data-test="fleet-filters">
      <AppInput
        v-model="filters.type"
        as="select"
        label="Type"
        :options="typeOptions"
      />
      <AppInput
        v-model="filters.status"
        as="select"
        label="Status"
        :options="statusOptions"
      />
      <AppInput
        v-model="filters.mfg"
        as="checkbox"
        label="Manufactured by me"
        :disabled="!userId"
      />
      <AppInput
        v-model="filters.op"
        as="checkbox"
        label="Operated by me"
        :disabled="!userId"
      />
      <div class="filter-bar__tail">
        <span class="filter-bar__count" data-test="fleet-count">
          {{ visibleAircraft.length }} of {{ aircraft.length }} shown
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

    <p v-if="loading">Loading fleet…</p>
    <p v-else-if="aircraft.length === 0" class="fleet-empty">
      No aircraft registered yet.
      <template v-if="isManufacturer || isAdmin">
        Create the first one with “New aircraft”.
      </template>
      <template v-else>
        Aircraft records are created by the manufacturer.
      </template>
    </p>
    <p v-else-if="visibleAircraft.length === 0" class="fleet-empty">
      No aircraft match the current filters.
    </p>

    <div class="card-grid card-grid--cols-3">
      <AppCard
        v-for="a in visibleAircraft"
        :key="a.id"
        :title="a.name ? `${a.name}` : a.serial"
        :to="`/aircraft/${a.id}`"
      >
        {{ a.aircraft_types?.name ?? 'Unknown type' }}
        <template v-if="a.aircraft_types?.class === 'fixed_wing'"> · fixed-wing</template>
        <template v-else-if="a.aircraft_types?.cells"> · {{ a.aircraft_types.cells }}S</template>
        <br />
        {{ statFor(a.id) }}
        <template #meta>
          <span class="mono-label">S/N {{ a.serial }}</span>
          <AppBadge :variant="statusVariant[a.status] ?? 'neutral'" square dot>
            {{ a.status }}
          </AppBadge>
        </template>
      </AppCard>
    </div>
  </AppShell>
</template>

<style scoped>
.fleet-actions {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 1rem;
}

.fleet-empty {
  color: var(--docs-text-muted);
}

/* C3 header stat */
.fleet-stat {
  display: inline-flex;
  align-items: baseline;
  gap: 0.6rem;
  border: 1px solid var(--docs-border, #d0d9f3);
  background: var(--docs-bg);
  padding: 0.5rem 0.9rem;
  margin-bottom: 1rem;
}

.fleet-stat__label {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--docs-primary);
}

.fleet-stat__value {
  font-family: var(--font-mono);
  font-size: 18px;
  font-weight: 600;
  color: var(--docs-text);
}

.fleet-stat__detail {
  font-size: 12px;
  color: var(--docs-text-muted);
}

/* C2 filter bar */
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
  min-width: 160px;
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
