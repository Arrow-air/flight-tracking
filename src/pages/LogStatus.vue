<script setup lang="ts">
/**
 * /logs — upload status per log across the pipeline
 * (uploaded → parsing → parsed / error). Realtime subscription on
 * flight_logs plus a poll fallback keeps the view live while the parser
 * chews the queue.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { RealtimeChannel } from '@supabase/supabase-js';
import AppShell from '../components/AppShell.vue';
import AppBadge from '../components/ui/AppBadge.vue';
import AppTable from '../components/ui/AppTable.vue';
import type { TableColumn } from '../components/ui/AppTable.vue';
import AlertBanner from '../components/AlertBanner.vue';
import { selectRows, type FlightLog } from '../lib/db';
import { supabase } from '../lib/supabase';
import { fmtBytes, fmtDateTime, pathBasename } from '../lib/format';

interface LogRow extends FlightLog {
  flights?: { id: string; title: string | null; aircraft_id: string } | null;
  user_profiles?: { name: string | null } | null;
}

const router = useRouter();
const logs = ref<LogRow[]>([]);
const loading = ref(true);
const error = ref('');
const lastRefresh = ref<Date | null>(null);

let channel: RealtimeChannel | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function load() {
  logs.value = await selectRows<LogRow[]>(
    supabase
      .from('flight_logs')
      .select('*, flights(id,title,aircraft_id), user_profiles!flight_logs_uploaded_by_fkey(name)')
      .order('uploaded_at', { ascending: false })
      .limit(200),
    'load flight logs',
  );
  lastRefresh.value = new Date();
}

onMounted(async () => {
  try {
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
  channel = supabase
    .channel('flight-log-status')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'flight_logs' },
      () => void load().catch(() => undefined),
    )
    .subscribe();
  pollTimer = setInterval(() => void load().catch(() => undefined), 10000);
});

onUnmounted(() => {
  if (channel) void supabase.removeChannel(channel);
  if (pollTimer) clearInterval(pollTimer);
});

const columns: TableColumn[] = [
  { key: 'file', label: 'Log file', mono: true },
  { key: 'size', label: 'Size', width: '90px', align: 'right', mono: true },
  { key: 'uploaded_at', label: 'Uploaded', width: '170px', mono: true },
  { key: 'uploader', label: 'By', width: '130px' },
  { key: 'status', label: 'Status', width: '120px' },
  { key: 'detail', label: 'Detail' },
];

const rows = computed(() =>
  logs.value.map((l) => ({
    id: l.id,
    file: pathBasename(l.object_path),
    size: fmtBytes(l.size_bytes),
    uploaded_at: fmtDateTime(l.uploaded_at),
    uploader: l.user_profiles?.name ?? '—',
    status: l.status,
    detail:
      l.status === 'error'
        ? l.error ?? 'parse failed'
        : l.status === 'parsed'
          ? l.sanitized_path
            ? 'summary + sanitized copy ready'
            : 'summary ready'
          : l.status === 'parsing'
            ? 'parser working…'
            : 'waiting for parser',
    flightId: l.flight_id,
  })),
);

const counts = computed(() => {
  const c = { uploaded: 0, parsing: 0, parsed: 0, error: 0 };
  for (const l of logs.value) c[l.status] += 1;
  return c;
});
</script>

<template>
  <AppShell :crumbs="[{ label: 'Flights', to: '/flights' }, { label: 'Log status' }]">
    <div class="page-header">
      <h1>Log status</h1>
      <p class="page-header__description">
        Every uploaded DataFlash log and where it sits in the parse pipeline.
        Updates live.
      </p>
    </div>

    <AlertBanner v-if="error" kind="error" :message="error" />

    <div class="log-counts">
      <AppBadge status="uploaded" square dot>uploaded {{ counts.uploaded }}</AppBadge>
      <AppBadge status="parsing" square dot>parsing {{ counts.parsing }}</AppBadge>
      <AppBadge status="parsed" square dot>parsed {{ counts.parsed }}</AppBadge>
      <AppBadge status="error" square dot>error {{ counts.error }}</AppBadge>
      <span v-if="lastRefresh" class="mono-label">refreshed {{ lastRefresh.toLocaleTimeString() }}</span>
    </div>

    <p v-if="loading">Loading logs…</p>
    <AppTable
      v-else
      :columns="columns"
      :rows="rows"
      row-key="id"
      clickable
      empty-text="No logs uploaded yet."
      @row-click="(row) => router.push(`/flights/${row.flightId}`)"
    >
      <template #cell-status="{ value }">
        <AppBadge :status="value as any" square dot>{{ value }}</AppBadge>
      </template>
    </AppTable>
  </AppShell>
</template>

<style scoped>
.log-counts {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}

.log-counts .mono-label {
  margin-left: auto;
}
</style>
