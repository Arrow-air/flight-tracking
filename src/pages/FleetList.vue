<script setup lang="ts">
/**
 * / — fleet list: aircraft cards with type, status and derived stats
 * (flight count + hours from flights / parsed log summaries).
 * "New aircraft" only for manufacturers/admins (RLS invariant 1).
 */
import { computed, onMounted, ref } from 'vue';
import AppShell from '../components/AppShell.vue';
import AppBadge from '../components/ui/AppBadge.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppCard from '../components/ui/AppCard.vue';
import AlertBanner from '../components/AlertBanner.vue';
import { isAdmin, isManufacturer } from '../lib/auth';
import { selectRows, type Aircraft, type Flight } from '../lib/db';
import { supabase } from '../lib/supabase';
import { fmtHours } from '../lib/format';

interface LogDuration {
  flight_id: string;
  flight_log_summary: { duration_s: number | null } | { duration_s: number | null }[] | null;
}

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

    <div v-if="isManufacturer || isAdmin" class="fleet-actions">
      <AppButton to="/aircraft/new" data-test="new-aircraft">+ New aircraft</AppButton>
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

    <div class="card-grid card-grid--cols-3">
      <AppCard
        v-for="a in aircraft"
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
</style>
