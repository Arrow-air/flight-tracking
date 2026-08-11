<script setup lang="ts">
/**
 * /flights/:id — the flight card: flight record + per-log parse results
 * (duration / distance / battery / modes timeline / events / errors /
 * health score) with GPS-privacy-aware downloads: raw .bin only for
 * admins + owners of a gps_private flight, sanitized copy for everyone.
 * Polls while any log is still uploaded/parsing.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import AppShell from '../components/AppShell.vue';
import AppBadge from '../components/ui/AppBadge.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppCard from '../components/ui/AppCard.vue';
import AppInput from '../components/ui/AppInput.vue';
import AlertBanner from '../components/AlertBanner.vue';
import { canViewRawGps, canWriteAircraft, userId } from '../lib/auth';
import {
  insertRow,
  selectRows,
  updateRow,
  type Flight,
  type FlightLog,
  type FlightLogSummary,
  type FlightNote,
  type Site,
} from '../lib/db';
import { supabase } from '../lib/supabase';
import {
  fmtDateTime,
  fmtDuration,
  fmtBytes,
  fmtNum,
  pathBasename,
  toDatetimeLocal,
  fromDatetimeLocal,
} from '../lib/format';
import {
  rawLogUrl,
  sanitizedLogUrl,
  uploadFlightLog,
  requeueLog,
  DuplicateLogError,
} from '../lib/logs';

interface FlightFull extends Flight {
  aircraft?: { id: string; serial: string; name: string | null; aircraft_types?: { name: string } | null } | null;
  sites?: { id: string; name: string } | null;
  user_profiles?: { name: string | null } | null;
  flight_tags?: { tags: { name: string } | null }[];
}

interface LogFull extends FlightLog {
  flight_log_summary: FlightLogSummary | FlightLogSummary[] | null;
}

const route = useRoute();
const flightId = computed(() => String(route.params.id));

const flight = ref<FlightFull | null>(null);
const logs = ref<LogFull[]>([]);
const notes = ref<(FlightNote & { user_profiles?: { name: string | null } | null })[]>([]);
const sites = ref<Site[]>([]);
const loading = ref(true);
const error = ref('');
const notice = ref('');

let pollTimer: ReturnType<typeof setInterval> | null = null;

const canWrite = computed(
  () => flight.value != null && canWriteAircraft(flight.value.aircraft_id),
);
const showRaw = computed(() => flight.value != null && canViewRawGps(flight.value));

function summaryOf(l: LogFull): FlightLogSummary | null {
  return Array.isArray(l.flight_log_summary)
    ? (l.flight_log_summary[0] ?? null)
    : l.flight_log_summary;
}

async function loadLogs() {
  logs.value = await selectRows<LogFull[]>(
    supabase
      .from('flight_logs')
      .select('*, flight_log_summary(*)')
      .eq('flight_id', flightId.value)
      .order('uploaded_at'),
    'load logs',
  );
  const pending = logs.value.some((l) => l.status === 'uploaded' || l.status === 'parsing');
  if (pending && !pollTimer) {
    pollTimer = setInterval(() => void loadLogs().catch(() => undefined), 5000);
  } else if (!pending && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function loadAll() {
  const [fl] = await Promise.all([
    selectRows<FlightFull[]>(
      supabase
        .from('flights')
        .select(
          '*, aircraft(id,serial,name,aircraft_types(name)), sites(id,name), user_profiles!flights_pilot_id_fkey(name), flight_tags(tags(name))',
        )
        .eq('id', flightId.value)
        .limit(1),
      'load flight',
    ),
    loadLogs(),
  ]);
  flight.value = fl[0] ?? null;
  if (!flight.value) {
    error.value = 'Flight not found.';
    return;
  }
  notes.value = await selectRows<typeof notes.value>(
    supabase
      .from('flight_notes')
      .select('*, user_profiles!flight_notes_author_fkey(name)')
      .eq('flight_id', flightId.value)
      .order('created_at'),
    'load notes',
  );
}

onMounted(async () => {
  try {
    await loadAll();
    sites.value = await selectRows<Site[]>(
      supabase.from('sites').select('*').order('name'),
      'load sites',
    );
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});

// --- edit ------------------------------------------------------------------
const editing = ref(false);
const editForm = ref({
  title: '',
  site_id: '',
  started_at: '',
  ended_at: '',
  notes: '',
  gps_private: true,
});

function startEdit() {
  if (!flight.value) return;
  editForm.value = {
    title: flight.value.title ?? '',
    site_id: flight.value.site_id ?? '',
    started_at: flight.value.started_at
      ? toDatetimeLocal(new Date(flight.value.started_at))
      : '',
    ended_at: flight.value.ended_at ? toDatetimeLocal(new Date(flight.value.ended_at)) : '',
    notes: flight.value.notes ?? '',
    gps_private: flight.value.gps_private,
  };
  editing.value = true;
}

async function saveEdit() {
  if (!flight.value) return;
  error.value = '';
  try {
    await updateRow('flights', flight.value.id, {
      title: editForm.value.title.trim() || null,
      site_id: editForm.value.site_id || null,
      started_at: fromDatetimeLocal(editForm.value.started_at),
      ended_at: fromDatetimeLocal(editForm.value.ended_at),
      notes: editForm.value.notes.trim() || null,
      gps_private: editForm.value.gps_private,
    }, 'update flight');
    editing.value = false;
    notice.value = 'Flight updated.';
    await loadAll();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

// --- add note --------------------------------------------------------------
const noteBody = ref('');

async function addNote() {
  if (!noteBody.value.trim() || !flight.value) return;
  error.value = '';
  try {
    await insertRow('flight_notes', {
      flight_id: flight.value.id,
      body: noteBody.value.trim(),
    }, 'add note');
    noteBody.value = '';
    await loadAll();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

// --- attach another log ----------------------------------------------------
const attachBusy = ref(false);

async function onAttach(ev: Event) {
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (!f || !flight.value) return;
  error.value = '';
  attachBusy.value = true;
  try {
    await uploadFlightLog(flight.value.id, f);
    notice.value = `${f.name} uploaded — queued for parsing.`;
    await loadLogs();
  } catch (e) {
    error.value =
      e instanceof DuplicateLogError
        ? e.message
        : e instanceof Error
          ? e.message
          : String(e);
  } finally {
    attachBusy.value = false;
    (ev.target as HTMLInputElement).value = '';
  }
}

async function retryParse(l: LogFull) {
  error.value = '';
  try {
    await requeueLog(l.id);
    notice.value = `${pathBasename(l.object_path)} re-queued for parsing.`;
    await loadLogs();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

// --- downloads -------------------------------------------------------------
async function downloadRaw(l: LogFull) {
  error.value = '';
  const url = await rawLogUrl(l.object_path);
  if (!url) {
    error.value =
      'Raw log denied: this flight is GPS-private — only admins and the flight owner can download the raw .bin. Use the sanitized copy.';
    return;
  }
  window.open(url, '_blank');
}

async function downloadSanitized(l: LogFull) {
  error.value = '';
  if (!l.sanitized_path) return;
  const url = await sanitizedLogUrl(l.sanitized_path);
  if (!url) {
    error.value = 'Sanitized copy not available yet.';
    return;
  }
  window.open(url, '_blank');
}

// --- render helpers --------------------------------------------------------
const tagNames = computed(
  () =>
    flight.value?.flight_tags
      ?.map((t) => t.tags?.name)
      .filter((n): n is string => !!n) ?? [],
);

function healthVariant(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'ok') return 'success';
  if (status === 'warn') return 'warning';
  if (status === 'fail') return 'danger';
  return 'neutral';
}

function gradeVariant(score: number | undefined): 'success' | 'warning' | 'danger' {
  if (score == null) return 'warning';
  if (score >= 80) return 'success';
  if (score >= 50) return 'warning';
  return 'danger';
}

function modeTimeline(s: FlightLogSummary): { mode: string; from: number; to: number | null }[] {
  const modes = s.modes ?? [];
  return modes.map((m, i) => ({
    mode: m.mode,
    from: m.t_s,
    to: modes[i + 1]?.t_s ?? s.duration_s ?? null,
  }));
}
</script>

<template>
  <AppShell
    :crumbs="[
      { label: 'Flights', to: '/flights' },
      { label: flight?.title ?? 'Flight' },
    ]"
  >
    <AlertBanner v-if="error" kind="error" :message="error" data-test="flight-error" />
    <AlertBanner v-if="notice" kind="success" :message="notice" />
    <p v-if="loading">Loading flight…</p>

    <template v-if="flight">
      <div class="page-header">
        <h1>
          {{ flight.title || `Flight ${fmtDateTime(flight.started_at)}` }}
          <AppBadge :variant="flight.gps_private ? 'neutral' : 'success'" square>
            GPS {{ flight.gps_private ? 'private' : 'shared' }}
          </AppBadge>
        </h1>
        <p class="page-header__description">
          {{ flight.aircraft ? (flight.aircraft.name || flight.aircraft.serial) : '—' }}
          <template v-if="flight.aircraft?.aircraft_types?.name">
            ({{ flight.aircraft.aircraft_types.name }})</template>
          · {{ flight.user_profiles?.name ?? 'unknown pilot' }}
          · {{ flight.sites?.name ?? 'no site' }}
          · {{ fmtDateTime(flight.started_at) }}
          <template v-if="flight.ended_at">→ {{ fmtDateTime(flight.ended_at) }}</template>
        </p>
      </div>

      <div class="fc-meta">
        <span v-for="t in tagNames" :key="t"><AppBadge variant="primary">{{ t }}</AppBadge></span>
        <span class="fc-meta__spacer" />
        <AppButton v-if="canWrite && !editing" size="sm" variant="secondary" @click="startEdit">
          Edit flight
        </AppButton>
        <router-link
          v-if="flight.aircraft"
          class="fc-meta__aircraft"
          :to="`/aircraft/${flight.aircraft.id}`"
        >
          Aircraft page →
        </router-link>
      </div>

      <form v-if="editing" class="fc-edit" @submit.prevent="saveEdit">
        <div class="fc-edit__row">
          <AppInput v-model="editForm.title" label="Title" />
          <AppInput
            v-model="editForm.site_id"
            as="select"
            label="Site"
            :options="[{ label: '—', value: '' }, ...sites.map((s) => ({ label: s.name, value: s.id }))]"
          />
        </div>
        <div class="fc-edit__row">
          <AppInput v-model="editForm.started_at" label="Started" type="datetime-local" />
          <AppInput v-model="editForm.ended_at" label="Ended" type="datetime-local" />
        </div>
        <AppInput v-model="editForm.notes" as="textarea" label="Notes" />
        <AppInput v-model="editForm.gps_private" as="checkbox" label="GPS private" />
        <div class="fc-edit__actions">
          <AppButton type="submit" size="sm">Save</AppButton>
          <AppButton size="sm" variant="ghost" @click="editing = false">Cancel</AppButton>
        </div>
      </form>

      <p v-if="flight.notes" class="fc-notes">{{ flight.notes }}</p>

      <!-- Logs + parse results -->
      <h2>Flight logs</h2>
      <div v-if="canWrite" class="fc-attach">
        <label class="fc-attach__btn">
          {{ attachBusy ? 'Uploading…' : '+ Attach .bin log' }}
          <input type="file" accept=".bin,.BIN" :disabled="attachBusy" @change="onAttach" />
        </label>
      </div>
      <p v-if="logs.length === 0" class="fc-muted">No logs attached to this flight.</p>

      <div v-for="l in logs" :key="l.id" class="fc-log">
        <div class="fc-log__head">
          <span class="fc-log__name">{{ pathBasename(l.object_path) }}</span>
          <span class="mono-label">{{ fmtBytes(l.size_bytes) }}</span>
          <AppBadge :status="l.status" square dot data-test="log-status">{{ l.status }}</AppBadge>
          <span class="fc-log__spacer" />
          <AppButton v-if="showRaw" size="sm" variant="secondary" @click="downloadRaw(l)">
            Raw .bin
          </AppButton>
          <AppButton
            v-if="l.sanitized_path"
            size="sm"
            variant="secondary"
            @click="downloadSanitized(l)"
          >
            Sanitized .bin
          </AppButton>
        </div>

        <template v-if="l.status === 'error'">
          <AlertBanner kind="error" :message="`Parse failed: ${l.error ?? 'unknown error'}`" />
          <AppButton v-if="canWrite" size="sm" variant="secondary" @click="retryParse(l)">
            Retry parse
          </AppButton>
        </template>
        <p v-else-if="l.status !== 'parsed'" class="fc-muted">
          {{ l.status === 'parsing' ? 'Parser is working on this log…' : 'Waiting for the parser…' }}
        </p>

        <template v-if="summaryOf(l)">
          <div class="fc-summary" data-test="log-summary">
            <!-- headline stats -->
            <div class="fc-stats">
              <div class="fc-stat">
                <span class="fc-stat__label">Duration</span>
                <span class="fc-stat__value">{{ fmtDuration(summaryOf(l)!.duration_s) }}</span>
              </div>
              <div class="fc-stat">
                <span class="fc-stat__label">Distance</span>
                <span class="fc-stat__value">{{ fmtNum(summaryOf(l)!.distance_m, 0, 'm') }}</span>
              </div>
              <div class="fc-stat">
                <span class="fc-stat__label">Max alt</span>
                <span class="fc-stat__value">{{ fmtNum(summaryOf(l)!.max_alt_m, 1, 'm') }}</span>
              </div>
              <div class="fc-stat">
                <span class="fc-stat__label">Max speed</span>
                <span class="fc-stat__value">{{ fmtNum(summaryOf(l)!.max_speed_mps, 1, 'm/s') }}</span>
              </div>
              <div class="fc-stat" data-test="health-score">
                <span class="fc-stat__label">Health</span>
                <span class="fc-stat__value">
                  {{ summaryOf(l)!.health?.score ?? '—' }}
                  <AppBadge :variant="gradeVariant(summaryOf(l)!.health?.score)" square>
                    {{ summaryOf(l)!.health?.grade ?? '?' }}
                  </AppBadge>
                </span>
              </div>
            </div>

            <div class="fc-panels">
              <!-- battery -->
              <AppCard title="Battery" data-test="battery">
                <dl class="fc-kv" v-if="summaryOf(l)!.battery">
                  <dt>Start</dt><dd>{{ fmtNum(summaryOf(l)!.battery?.volt_start, 2, 'V') }}</dd>
                  <dt>Min</dt><dd>{{ fmtNum(summaryOf(l)!.battery?.volt_min, 2, 'V') }}</dd>
                  <dt>Sag</dt><dd>{{ fmtNum(summaryOf(l)!.battery?.sag_v, 2, 'V') }}</dd>
                  <dt>Per-cell min</dt>
                  <dd>
                    {{ fmtNum(summaryOf(l)!.battery?.per_cell_min, 3, 'V') }}
                    <template v-if="summaryOf(l)!.battery?.cells">
                      ({{ summaryOf(l)!.battery?.cells }}S<template
                        v-if="summaryOf(l)!.battery?.cells_source === 'inferred_from_voltage'"
                      > est.</template>)
                    </template>
                  </dd>
                  <dt>Used</dt><dd>{{ fmtNum(summaryOf(l)!.battery?.mah_used, 0, 'mAh') }}</dd>
                  <dt>Peak current</dt><dd>{{ fmtNum(summaryOf(l)!.battery?.curr_max_a, 1, 'A') }}</dd>
                </dl>
                <p v-else class="fc-muted">No battery telemetry in this log.</p>
              </AppCard>

              <!-- modes timeline -->
              <AppCard title="Modes" data-test="modes">
                <ol v-if="summaryOf(l)!.modes?.length" class="fc-modes">
                  <li v-for="(m, i) in modeTimeline(summaryOf(l)!)" :key="i">
                    <span class="fc-modes__time">{{ fmtDuration(m.from) }}</span>
                    <span class="fc-modes__mode">{{ m.mode }}</span>
                    <span v-if="m.to != null" class="fc-modes__dur">{{ fmtDuration(m.to - m.from) }}</span>
                  </li>
                </ol>
                <p v-else class="fc-muted">No mode changes recorded.</p>
              </AppCard>

              <!-- events + errors -->
              <AppCard title="Events">
                <ul v-if="summaryOf(l)!.events?.length" class="fc-events">
                  <li v-for="(e, i) in summaryOf(l)!.events!.slice(0, 12)" :key="i">
                    <span class="fc-modes__time">{{ fmtDuration(e.t_s) }}</span>
                    {{ e.event }}
                  </li>
                  <li v-if="summaryOf(l)!.events!.length > 12" class="fc-muted">
                    +{{ summaryOf(l)!.events!.length - 12 }} more
                  </li>
                </ul>
                <p v-else class="fc-muted">No arm/disarm events.</p>
                <template v-if="summaryOf(l)!.errors?.length">
                  <p class="fc-errors">{{ summaryOf(l)!.errors!.length }} error record(s) in log.</p>
                </template>
              </AppCard>
            </div>

            <!-- health checks -->
            <details class="fc-health">
              <summary>Health checks ({{ summaryOf(l)!.health?.checks?.length ?? 0 }})</summary>
              <table class="fc-health__table">
                <tbody>
                  <tr v-for="c in summaryOf(l)!.health?.checks ?? []" :key="c.name">
                    <td><AppBadge :variant="healthVariant(c.status)" square dot>{{ c.status }}</AppBadge></td>
                    <td class="fc-health__name">{{ c.name }}</td>
                    <td class="fc-health__value">
                      {{ c.value != null ? c.value : '—' }}
                      <template v-if="c.threshold != null"> / {{ c.threshold }}</template>
                    </td>
                    <td class="fc-health__detail">{{ c.detail }}</td>
                  </tr>
                </tbody>
              </table>
            </details>
          </div>
        </template>
      </div>

      <!-- Notes -->
      <h2>Notes</h2>
      <div class="fc-notelist">
        <p v-if="notes.length === 0" class="fc-muted">No notes yet.</p>
        <div v-for="n in notes" :key="n.id" class="fc-note">
          <div class="fc-note__head">
            <strong>{{ n.user_profiles?.name ?? 'unknown' }}</strong>
            <AppBadge variant="neutral">{{ n.type }}</AppBadge>
            <span class="mono-label">{{ fmtDateTime(n.created_at) }}</span>
          </div>
          <p class="fc-note__body">{{ n.body }}</p>
        </div>
      </div>
      <form class="fc-addnote" @submit.prevent="addNote">
        <AppInput v-model="noteBody" as="textarea" label="Add note" :rows="2" placeholder="Observation, anomaly, follow-up…" />
        <AppButton type="submit" size="sm" :disabled="!noteBody.trim()">Add note</AppButton>
      </form>
    </template>
  </AppShell>
</template>

<style scoped>
.fc-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}

.fc-meta__spacer {
  flex: 1;
}

.fc-meta__aircraft {
  font-size: 13px;
}

.fc-edit {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  border: 1px solid var(--docs-border, #d0d9f3);
  background: var(--docs-bg-subtle, #f7f8fa);
  padding: 1rem;
  margin-bottom: 1.25rem;
}

.fc-edit__row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.fc-edit__actions {
  display: flex;
  gap: 0.75rem;
}

.fc-notes {
  white-space: pre-wrap;
  font-size: 14px;
  color: var(--docs-text-secondary);
  border-left: 3px solid var(--docs-border, #d0d9f3);
  padding-left: 0.9rem;
  margin-bottom: 1.5rem;
}

.fc-muted {
  color: var(--docs-text-muted);
  font-size: 14px;
}

.fc-attach {
  margin-bottom: 1rem;
}

.fc-attach__btn {
  display: inline-block;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--docs-primary);
  border: 1px solid var(--docs-primary);
  padding: 0.45rem 0.9rem;
  background: var(--docs-bg);
  box-shadow: var(--shadow-hard, 3px 3px 0 0 rgba(0, 0, 0, 0.08));
}

.fc-attach__btn input {
  display: none;
}

.fc-log {
  border: 1px solid var(--docs-border, #d0d9f3);
  padding: 1rem;
  margin-bottom: 1.25rem;
  background: var(--docs-bg);
}

.fc-log__head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}

.fc-log__name {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
}

.fc-log__spacer {
  flex: 1;
}

.fc-stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 1px;
  background: var(--docs-border, #d0d9f3);
  border: 1px solid var(--docs-border, #d0d9f3);
  margin-bottom: 1rem;
}

@media (max-width: 900px) {
  .fc-stats {
    grid-template-columns: repeat(2, 1fr);
  }
}

.fc-stat {
  background: var(--docs-bg);
  padding: 0.75rem 0.9rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.fc-stat__label {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--docs-text-muted);
}

.fc-stat__value {
  font-family: var(--font-mono);
  font-size: 20px;
  font-weight: 600;
  color: var(--docs-text);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.fc-panels {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
  margin-bottom: 1rem;
}

@media (max-width: 1000px) {
  .fc-panels {
    grid-template-columns: 1fr;
  }
}

.fc-kv {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.3rem 1rem;
  margin: 0;
  font-size: 14px;
}

.fc-kv dt {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--docs-text-muted);
  align-self: baseline;
}

.fc-kv dd {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 13px;
}

.fc-modes,
.fc-events {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: 13px;
  max-height: 220px;
  overflow-y: auto;
}

.fc-modes li,
.fc-events li {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}

.fc-modes__time {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--docs-text-muted);
  min-width: 52px;
}

.fc-modes__mode {
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--docs-primary);
}

.fc-modes__dur {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--docs-text-muted);
}

.fc-errors {
  margin: 0.6rem 0 0;
  font-size: 13px;
  color: #b91c1c;
  font-weight: 500;
}

.fc-health {
  border: 1px solid var(--docs-border-muted, #e5e7eb);
  padding: 0.6rem 0.9rem;
}

.fc-health summary {
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--docs-primary);
}

.fc-health__table {
  width: 100%;
  margin-top: 0.6rem;
  border-collapse: collapse;
  font-size: 13px;
}

.fc-health__table td {
  padding: 0.3rem 0.6rem 0.3rem 0;
  vertical-align: top;
}

.fc-health__name {
  font-family: var(--font-mono);
  font-weight: 600;
}

.fc-health__value {
  font-family: var(--font-mono);
  white-space: nowrap;
}

.fc-health__detail {
  color: var(--docs-text-muted);
}

.fc-notelist {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.fc-note {
  border: 1px solid var(--docs-border-muted, #e5e7eb);
  padding: 0.6rem 0.9rem;
}

.fc-note__head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 13px;
}

.fc-note__body {
  margin: 0.35rem 0 0;
  font-size: 14px;
  white-space: pre-wrap;
}

.fc-addnote {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  max-width: 560px;
  align-items: flex-start;
  margin-bottom: 2rem;
}

.fc-addnote > :first-child {
  width: 100%;
}
</style>
