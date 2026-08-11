<script setup lang="ts">
/**
 * /upload — bulk-dump intake: drop a whole day's .BIN files, set batch
 * defaults once (aircraft / pilot / site), and every file becomes a flight
 * stub timed from the log's own GPS clock (fallback: file mtime) with the
 * log queued for the parser. Near-zero typing; details editable later on
 * each flight card. All stubs share a session_id (the "day" grouping).
 */
import { computed, onMounted, ref } from 'vue';
import AppShell from '../components/AppShell.vue';
import AppBadge from '../components/ui/AppBadge.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppTable from '../components/ui/AppTable.vue';
import type { TableColumn } from '../components/ui/AppTable.vue';
import AlertBanner from '../components/AlertBanner.vue';
import { auth, isAdmin, userId } from '../lib/auth';
import { insertRow, selectRows, type Aircraft, type Flight, type Profile, type Site } from '../lib/db';
import { supabase } from '../lib/supabase';
import { extractLogStartTime } from '../lib/binlog';
import { uploadFlightLog, DuplicateLogError } from '../lib/logs';
import { fmtBytes, fmtDateTime } from '../lib/format';

type ItemState = 'queued' | 'timing' | 'creating' | 'uploading' | 'done' | 'duplicate' | 'failed';

interface Item {
  file: File;
  state: ItemState;
  startTime: Date | null;
  timeSource: 'gps' | 'mtime' | null;
  flightId: string | null;
  message: string;
}

const aircraft = ref<Aircraft[]>([]);
const sites = ref<Site[]>([]);
const profiles = ref<Profile[]>([]);
const error = ref('');
const loading = ref(true);

const defaults = ref({ aircraft_id: '', pilot_id: '', site_id: '', gps_private: true });

const items = ref<Item[]>([]);
const running = ref(false);
const dragOver = ref(false);

const writableAircraft = computed(() =>
  isAdmin.value ? aircraft.value : aircraft.value.filter((a) => auth.operatorOf.includes(a.id)),
);

onMounted(async () => {
  try {
    [aircraft.value, sites.value, profiles.value] = await Promise.all([
      selectRows<Aircraft[]>(
        supabase.from('aircraft').select('*, aircraft_types(name)').order('serial'),
        'load aircraft',
      ),
      selectRows<Site[]>(supabase.from('sites').select('*').order('name'), 'load sites'),
      selectRows<Profile[]>(
        supabase.from('user_profiles').select('id,name,roles,gps_default_private').order('name'),
        'load pilots',
      ),
    ]);
    defaults.value.pilot_id = userId.value ?? '';
    defaults.value.gps_private = auth.profile?.gps_default_private ?? true;
    if (writableAircraft.value.length === 1) {
      defaults.value.aircraft_id = writableAircraft.value[0].id;
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});

function addFiles(list: FileList | File[] | null) {
  if (!list) return;
  for (const f of Array.from(list)) {
    if (!/\.bin$/i.test(f.name)) continue;
    if (items.value.some((i) => i.file.name === f.name && i.file.size === f.size)) continue;
    items.value.push({
      file: f,
      state: 'queued',
      startTime: null,
      timeSource: null,
      flightId: null,
      message: '',
    });
  }
}

function onDrop(ev: DragEvent) {
  dragOver.value = false;
  addFiles(ev.dataTransfer?.files ?? null);
}

function onPick(ev: Event) {
  addFiles((ev.target as HTMLInputElement).files);
}

async function processAll() {
  error.value = '';
  if (!defaults.value.aircraft_id) {
    error.value = 'Pick a default aircraft for the batch first.';
    return;
  }
  running.value = true;
  const sessionId = crypto.randomUUID();
  for (const item of items.value) {
    if (item.state !== 'queued' && item.state !== 'failed') continue;
    try {
      item.state = 'timing';
      const { time, source } = await extractLogStartTime(item.file);
      item.startTime = time;
      item.timeSource = source;

      item.state = 'creating';
      const flight = await insertRow<Flight>('flights', {
        aircraft_id: defaults.value.aircraft_id,
        pilot_id: defaults.value.pilot_id || null,
        site_id: defaults.value.site_id || null,
        started_at: time.toISOString(),
        title: `Bulk dump · ${item.file.name}`,
        session_id: sessionId,
        gps_private: defaults.value.gps_private,
      }, `create flight stub for ${item.file.name}`);
      item.flightId = flight.id;

      item.state = 'uploading';
      await uploadFlightLog(flight.id, item.file);
      item.state = 'done';
      item.message = 'Flight stub created, log queued for parsing.';
    } catch (e) {
      if (e instanceof DuplicateLogError) {
        item.state = 'duplicate';
        item.message = e.message;
      } else {
        item.state = 'failed';
        item.message = e instanceof Error ? e.message : String(e);
      }
    }
  }
  running.value = false;
}

const columns: TableColumn[] = [
  { key: 'name', label: 'File', mono: true },
  { key: 'size', label: 'Size', width: '90px', align: 'right', mono: true },
  { key: 'time', label: 'Start time', width: '190px', mono: true },
  { key: 'state', label: 'Status', width: '130px' },
  { key: 'message', label: 'Detail' },
];

const rows = computed(() =>
  items.value.map((i, idx) => ({
    id: idx,
    name: i.file.name,
    size: fmtBytes(i.file.size),
    time: i.startTime
      ? `${fmtDateTime(i.startTime.toISOString())}${i.timeSource === 'mtime' ? ' (mtime)' : ''}`
      : '—',
    state: i.state,
    message: i.message || '—',
    flightId: i.flightId,
  })),
);

const stateVariant: Record<ItemState, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = {
  queued: 'neutral',
  timing: 'info',
  creating: 'info',
  uploading: 'warning',
  done: 'success',
  duplicate: 'warning',
  failed: 'danger',
};

const doneCount = computed(() => items.value.filter((i) => i.state === 'done').length);
</script>

<template>
  <AppShell :crumbs="[{ label: 'Flights', to: '/flights' }, { label: 'Bulk upload' }]">
    <div class="page-header">
      <h1>Bulk upload</h1>
      <p class="page-header__description">
        End of the day? Drop every log at once. Each file becomes a flight
        stub timed from the log itself — add details later if you want.
      </p>
    </div>

    <AlertBanner v-if="error" kind="error" :message="error" />
    <AlertBanner
      v-if="!loading && writableAircraft.length === 0"
      kind="warning"
      message="You are not assigned as operator of any aircraft — batch creation would be rejected. Ask a manufacturer/admin for an assignment."
    />
    <AlertBanner
      v-if="doneCount > 0 && !running"
      kind="success"
      :message="`${doneCount} flight stub${doneCount === 1 ? '' : 's'} created — logs are queued for the parser. See Log status.`"
    />

    <h2>Batch defaults</h2>
    <div class="bulk-defaults">
      <AppInput
        v-model="defaults.aircraft_id"
        as="select"
        label="Aircraft"
        required
        :options="[
          { label: 'Select aircraft…', value: '' },
          ...writableAircraft.map((a) => ({
            label: `${a.name || a.serial} (${a.serial})`,
            value: a.id,
          })),
        ]"
      />
      <AppInput
        v-model="defaults.pilot_id"
        as="select"
        label="Pilot"
        :options="[{ label: '—', value: '' }, ...profiles.map((p) => ({ label: p.name ?? p.id, value: p.id }))]"
      />
      <AppInput
        v-model="defaults.site_id"
        as="select"
        label="Site"
        :options="[{ label: '—', value: '' }, ...sites.map((s) => ({ label: s.name, value: s.id }))]"
      />
      <AppInput v-model="defaults.gps_private" as="checkbox" label="GPS private" />
    </div>

    <div
      class="dropzone"
      :class="{ 'is-over': dragOver }"
      data-test="dropzone"
      @dragover.prevent="dragOver = true"
      @dragleave="dragOver = false"
      @drop.prevent="onDrop"
    >
      <p class="dropzone__title">Drop .BIN files here</p>
      <p class="dropzone__sub">or</p>
      <label class="dropzone__pick">
        Browse…
        <input type="file" multiple accept=".bin,.BIN" @change="onPick" />
      </label>
    </div>

    <div v-if="items.length" class="bulk-actions">
      <span class="mono-label">{{ items.length }} file(s) staged</span>
      <AppButton :disabled="running || !defaults.aircraft_id" data-test="start-bulk" @click="processAll">
        {{ running ? 'Processing…' : `Create ${items.length} flight stub(s)` }}
      </AppButton>
    </div>

    <AppTable v-if="items.length" :columns="columns" :rows="rows" row-key="id">
      <template #cell-state="{ value }">
        <AppBadge :variant="stateVariant[value as ItemState]" square dot>{{ value }}</AppBadge>
      </template>
      <template #cell-message="{ row, value }">
        <router-link v-if="row.flightId" :to="`/flights/${row.flightId}`">open flight</router-link>
        <template v-if="row.flightId"> · </template>{{ value }}
      </template>
    </AppTable>
  </AppShell>
</template>

<style scoped>
.bulk-defaults {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr auto;
  gap: 1rem;
  align-items: end;
  margin-bottom: 1.25rem;
}

@media (max-width: 900px) {
  .bulk-defaults {
    grid-template-columns: 1fr;
  }
}

.dropzone {
  border: 2px dashed var(--docs-border, #d0d9f3);
  background: var(--docs-bg-subtle, #f7f8fa);
  padding: 2.25rem 1.5rem;
  text-align: center;
  margin-bottom: 1.25rem;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.dropzone.is-over {
  border-color: var(--docs-primary);
  background: var(--docs-primary-light, rgba(8, 67, 191, 0.08));
}

.dropzone__title {
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--docs-primary);
  margin: 0;
}

.dropzone__sub {
  margin: 0.4rem 0;
  color: var(--docs-text-muted);
  font-size: 12px;
}

.dropzone__pick {
  display: inline-block;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--docs-primary);
  border: 1px solid var(--docs-primary);
  padding: 0.4rem 0.9rem;
  background: var(--docs-bg);
}

.dropzone__pick input {
  display: none;
}

.bulk-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}
</style>
