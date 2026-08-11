<script setup lang="ts">
/**
 * /flights — all flights (fleet-visible reads), with per-flight log status
 * rollup. Rows open the flight card.
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppShell from '../components/AppShell.vue';
import AppBadge from '../components/ui/AppBadge.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppTable from '../components/ui/AppTable.vue';
import type { TableColumn } from '../components/ui/AppTable.vue';
import AlertBanner from '../components/AlertBanner.vue';
import { selectRows, type Flight, type FlightLogStatus } from '../lib/db';
import { supabase } from '../lib/supabase';
import { fmtDateTime, fmtDuration } from '../lib/format';
import { flightDurationS, flightStartIso, type LogWithSummary } from '../lib/flightMetrics';

interface FlightRow extends Flight {
  aircraft?: { serial: string; name: string | null } | null;
  sites?: { name: string } | null;
  user_profiles?: { name: string | null } | null;
  flight_logs?: ({ id: string; status: FlightLogStatus } & LogWithSummary)[];
}

const router = useRouter();
const flights = ref<FlightRow[]>([]);
const loading = ref(true);
const error = ref('');

onMounted(async () => {
  try {
    flights.value = await selectRows<FlightRow[]>(
      supabase
        .from('flights')
        .select(
          '*, aircraft(serial,name), sites(name), user_profiles!flights_pilot_id_fkey(name), flight_logs(id,status,flight_log_summary(duration_s,start_time_utc))',
        )
        .order('started_at', { ascending: false, nullsFirst: false })
        .limit(200),
      'load flights',
    );
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});

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
  flights.value.map((f) => {
    const roll = logRollup(f.flight_logs);
    return {
      id: f.id,
      // F3: log-derived start_time_utc wins over the hand-entered time
      started_at: fmtDateTime(flightStartIso(f.flight_logs, f.started_at)),
      aircraft: f.aircraft ? f.aircraft.name || f.aircraft.serial : '—',
      title: f.title ?? '(untitled)',
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

    <div class="flights-actions">
      <AppButton to="/flights/new">+ Quick log</AppButton>
      <AppButton to="/upload" variant="secondary">Bulk upload</AppButton>
    </div>

    <p v-if="loading">Loading flights…</p>
    <AppTable
      v-else
      :columns="columns"
      :rows="rows"
      row-key="id"
      clickable
      empty-text="No flights logged yet — use Quick log or Bulk upload."
      @row-click="(row) => router.push(`/flights/${row.id}`)"
    >
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
</style>
