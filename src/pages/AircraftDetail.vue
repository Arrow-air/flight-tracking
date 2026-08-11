<script setup lang="ts">
/**
 * /aircraft/:id — registry fields, operator assignments, component
 * install/remove history, airframe events (maintenance/incident/field
 * action) and this airframe's flights. Write actions are role-gated to
 * mirror RLS; every rejected write still surfaces loudly.
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import AppShell from '../components/AppShell.vue';
import AppBadge from '../components/ui/AppBadge.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppCard from '../components/ui/AppCard.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppTable from '../components/ui/AppTable.vue';
import type { TableColumn } from '../components/ui/AppTable.vue';
import AlertBanner from '../components/AlertBanner.vue';
import {
  canWriteAircraft,
  canWriteComponents,
  isAdmin,
  isManufacturer,
  refreshProfile,
} from '../lib/auth';
import {
  insertRow,
  selectRows,
  updateRow,
  type Aircraft,
  type AirframeEvent,
  type ComponentEvent,
  type ComponentRow,
  type Flight,
  type Profile,
} from '../lib/db';
import { supabase } from '../lib/supabase';
import { fmtDate, fmtDateTime, fmtDuration, toDatetimeLocal, fromDatetimeLocal } from '../lib/format';
import { useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();
const aircraftId = computed(() => String(route.params.id));

const aircraft = ref<Aircraft | null>(null);
const operators = ref<{ user_id: string; granted_at: string; profile: Profile | null }[]>([]);
const componentEvents = ref<ComponentEvent[]>([]);
const airframeEvents = ref<AirframeEvent[]>([]);
const flights = ref<(Flight & { sites?: { name: string } | null })[]>([]);
const components = ref<ComponentRow[]>([]);
const profiles = ref<Profile[]>([]);

const loading = ref(true);
const error = ref('');
const notice = ref('');

const canWrite = computed(() => aircraft.value != null && canWriteAircraft(aircraft.value.id));
const canWriteComp = computed(() => aircraft.value != null && canWriteComponents(aircraft.value.id));
const canEditRegistry = computed(() => canWrite.value || isManufacturer.value);

const statusVariant: Record<string, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  maintenance: 'warning',
  retired: 'neutral',
};

// --- registry edit ---------------------------------------------------------
const editing = ref(false);
const editForm = ref({ name: '', status: 'active', design_rev: '', notes: '' });

function startEdit() {
  if (!aircraft.value) return;
  editForm.value = {
    name: aircraft.value.name ?? '',
    status: aircraft.value.status,
    design_rev: aircraft.value.design_rev ?? '',
    notes: aircraft.value.notes ?? '',
  };
  editing.value = true;
}

async function saveEdit() {
  if (!aircraft.value) return;
  error.value = '';
  try {
    aircraft.value = {
      ...aircraft.value,
      ...(await updateRow<Aircraft>('aircraft', aircraft.value.id, {
        name: editForm.value.name.trim() || null,
        status: editForm.value.status,
        design_rev: editForm.value.design_rev.trim() || null,
        notes: editForm.value.notes.trim() || null,
      }, 'update aircraft')),
      aircraft_types: aircraft.value.aircraft_types,
    };
    editing.value = false;
    notice.value = 'Aircraft updated.';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

// --- component events ------------------------------------------------------
const showCompForm = ref(false);
const compForm = ref({
  event: 'installed' as 'installed' | 'removed',
  component_id: '',
  newKind: '',
  newPartNo: '',
  newSerial: '',
  position: '',
  occurred_at: toDatetimeLocal(new Date()),
  reason: '',
});

async function submitComponentEvent() {
  if (!aircraft.value) return;
  error.value = '';
  try {
    let componentId = compForm.value.component_id;
    if (!componentId) {
      if (!compForm.value.newKind.trim()) {
        throw new Error('Pick an existing component or enter a kind for a new one.');
      }
      const comp = await insertRow<ComponentRow>('components', {
        kind: compForm.value.newKind.trim(),
        part_no: compForm.value.newPartNo.trim() || null,
        serial: compForm.value.newSerial.trim() || null,
      }, 'register component');
      componentId = comp.id;
    }
    await insertRow('component_events', {
      aircraft_id: aircraft.value.id,
      component_id: componentId,
      event: compForm.value.event,
      position: compForm.value.position.trim() || null,
      occurred_at: fromDatetimeLocal(compForm.value.occurred_at) ?? new Date().toISOString(),
      reason: compForm.value.reason.trim() || null,
    }, 'log component event');
    showCompForm.value = false;
    compForm.value.newKind = '';
    compForm.value.newPartNo = '';
    compForm.value.newSerial = '';
    compForm.value.reason = '';
    notice.value = 'Component event logged.';
    await loadEvents();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

// --- airframe events -------------------------------------------------------
const showEventForm = ref(false);
const eventForm = ref({
  kind: 'maintenance' as AirframeEvent['kind'],
  title: '',
  body: '',
  occurred_at: toDatetimeLocal(new Date()),
});

async function submitAirframeEvent() {
  if (!aircraft.value) return;
  error.value = '';
  try {
    await insertRow('airframe_events', {
      aircraft_id: aircraft.value.id,
      kind: eventForm.value.kind,
      title: eventForm.value.title.trim(),
      body: eventForm.value.body.trim() || null,
      occurred_at: fromDatetimeLocal(eventForm.value.occurred_at) ?? new Date().toISOString(),
    }, 'log airframe event');
    showEventForm.value = false;
    eventForm.value.title = '';
    eventForm.value.body = '';
    notice.value = 'Airframe event logged.';
    await loadEvents();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

// --- operator assignment (manufacturer/admin) ------------------------------
const assignUserId = ref('');

async function assignOperator() {
  if (!aircraft.value || !assignUserId.value) return;
  error.value = '';
  try {
    const { error: e } = await supabase.from('aircraft_operators').insert({
      aircraft_id: aircraft.value.id,
      user_id: assignUserId.value,
    });
    if (e) throw new Error(`assign operator: ${e.message}`);
    notice.value = 'Operator assigned.';
    await Promise.all([loadOperators(), refreshProfile()]);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function revokeOperator(uid: string) {
  if (!aircraft.value) return;
  error.value = '';
  try {
    const { data, error: e } = await supabase
      .from('aircraft_operators')
      .delete()
      .eq('aircraft_id', aircraft.value.id)
      .eq('user_id', uid)
      .select();
    if (e) throw new Error(`revoke operator: ${e.message}`);
    if (!data?.length) throw new Error('revoke operator: 0 rows deleted — not permitted.');
    notice.value = 'Operator revoked.';
    await Promise.all([loadOperators(), refreshProfile()]);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

// --- loads -----------------------------------------------------------------
async function loadOperators() {
  const rows = await selectRows<{ user_id: string; granted_at: string; user_profiles: Profile | null }[]>(
    supabase
      .from('aircraft_operators')
      .select('user_id, granted_at, user_profiles!aircraft_operators_user_id_fkey(id,name,roles,gps_default_private)')
      .eq('aircraft_id', aircraftId.value),
    'load operators',
  );
  operators.value = rows.map((r) => ({
    user_id: r.user_id,
    granted_at: r.granted_at,
    profile: Array.isArray(r.user_profiles) ? r.user_profiles[0] ?? null : r.user_profiles,
  }));
}

async function loadEvents() {
  [componentEvents.value, airframeEvents.value] = await Promise.all([
    selectRows<ComponentEvent[]>(
      supabase
        .from('component_events')
        .select('*, components(id,kind,part_no,serial,batch_no,vendor,notes)')
        .eq('aircraft_id', aircraftId.value)
        .order('occurred_at', { ascending: false }),
      'load component history',
    ),
    selectRows<AirframeEvent[]>(
      supabase
        .from('airframe_events')
        .select('*')
        .eq('aircraft_id', aircraftId.value)
        .order('occurred_at', { ascending: false }),
      'load airframe events',
    ),
  ]);
}

onMounted(async () => {
  try {
    const [ac] = await Promise.all([
      selectRows<Aircraft[]>(
        supabase
          .from('aircraft')
          .select('*, aircraft_types(id,name,class,cells)')
          .eq('id', aircraftId.value)
          .limit(1),
        'load aircraft',
      ),
      loadOperators(),
      loadEvents(),
    ]);
    aircraft.value = ac[0] ?? null;
    if (!aircraft.value) {
      error.value = 'Aircraft not found.';
      return;
    }
    const [fl, comps, profs] = await Promise.all([
      selectRows<typeof flights.value>(
        supabase
          .from('flights')
          .select('*, sites(name)')
          .eq('aircraft_id', aircraftId.value)
          .order('started_at', { ascending: false, nullsFirst: false })
          .limit(50),
        'load flights',
      ),
      selectRows<ComponentRow[]>(
        supabase.from('components').select('id,kind,part_no,serial,batch_no,vendor,notes').order('kind'),
        'load components',
      ),
      selectRows<Profile[]>(
        supabase.from('user_profiles').select('id,name,roles,gps_default_private').order('name'),
        'load users',
      ),
    ]);
    flights.value = fl;
    components.value = comps;
    profiles.value = profs;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});

const compColumns: TableColumn[] = [
  { key: 'occurred_at', label: 'When', width: '160px', mono: true },
  { key: 'event', label: 'Event', width: '110px' },
  { key: 'component', label: 'Component' },
  { key: 'position', label: 'Position', width: '130px' },
  { key: 'reason', label: 'Reason' },
];

const compRows = computed(() =>
  componentEvents.value.map((e) => ({
    id: e.id,
    occurred_at: fmtDateTime(e.occurred_at),
    event: e.event,
    component: e.components
      ? `${e.components.kind}${e.components.part_no ? ` · ${e.components.part_no}` : ''}${e.components.serial ? ` · S/N ${e.components.serial}` : ''}`
      : e.component_id,
    position: e.position ?? '—',
    reason: e.reason ?? '—',
  })),
);

const flightColumns: TableColumn[] = [
  { key: 'started_at', label: 'Start', width: '170px', mono: true },
  { key: 'title', label: 'Title' },
  { key: 'site', label: 'Site' },
  { key: 'duration', label: 'Duration', width: '100px', align: 'right', mono: true },
  { key: 'gps', label: 'GPS', width: '90px' },
];

const flightRows = computed(() =>
  flights.value.map((f) => ({
    id: f.id,
    started_at: fmtDateTime(f.started_at),
    title: f.title ?? '(untitled)',
    site: f.sites?.name ?? '—',
    duration:
      f.started_at && f.ended_at
        ? fmtDuration((new Date(f.ended_at).getTime() - new Date(f.started_at).getTime()) / 1000)
        : '—',
    gps: f.gps_private ? 'private' : 'shared',
  })),
);

const kindVariant: Record<string, 'warning' | 'danger' | 'info'> = {
  maintenance: 'warning',
  incident: 'danger',
  field_action: 'info',
};
</script>

<template>
  <AppShell
    :crumbs="[
      { label: 'Fleet', to: '/' },
      { label: 'Aircraft', to: '/' },
      { label: aircraft?.serial ?? '…' },
    ]"
  >
    <AlertBanner v-if="error" kind="error" :message="error" />
    <AlertBanner v-if="notice" kind="success" :message="notice" />
    <p v-if="loading">Loading aircraft…</p>

    <template v-if="aircraft">
      <div class="page-header">
        <h1>
          {{ aircraft.name || aircraft.serial }}
          <AppBadge :variant="statusVariant[aircraft.status] ?? 'neutral'" square dot>
            {{ aircraft.status }}
          </AppBadge>
        </h1>
        <p class="page-header__description">
          {{ aircraft.aircraft_types?.name }} ·
          {{ aircraft.aircraft_types?.class === 'fixed_wing' ? 'fixed-wing' : 'multirotor' }}
          <template v-if="aircraft.aircraft_types?.cells"> · {{ aircraft.aircraft_types.cells }}S</template>
        </p>
      </div>

      <!-- Registry -->
      <h2>Registry</h2>
      <div v-if="!editing" class="registry">
        <AppCard title="Identity">
          <dl class="registry__list">
            <dt>Serial</dt><dd class="mono">{{ aircraft.serial }}</dd>
            <dt>Type</dt><dd>{{ aircraft.aircraft_types?.name ?? '—' }}</dd>
            <dt>Design rev</dt><dd class="mono">{{ aircraft.design_rev ?? '—' }}</dd>
            <dt>Built</dt><dd>{{ fmtDate(aircraft.built_at) }}</dd>
          </dl>
          <template #meta>
            <span class="mono-label">Registered {{ fmtDate(aircraft.created_at) }}</span>
            <AppButton v-if="canEditRegistry" size="sm" variant="secondary" @click="startEdit">
              Edit
            </AppButton>
          </template>
        </AppCard>

        <AppCard title="Operators">
          <p v-if="operators.length === 0" class="muted">No operators assigned.</p>
          <ul class="registry__ops">
            <li v-for="op in operators" :key="op.user_id">
              <span>{{ op.profile?.name ?? op.user_id }}</span>
              <span class="mono-label">since {{ fmtDate(op.granted_at) }}</span>
              <AppButton
                v-if="isManufacturer || isAdmin"
                size="sm"
                variant="ghost"
                @click="revokeOperator(op.user_id)"
              >
                Revoke
              </AppButton>
            </li>
          </ul>
          <div v-if="isManufacturer || isAdmin" class="registry__assign">
            <AppInput
              v-model="assignUserId"
              as="select"
              label="Assign operator"
              :options="[
                { label: 'Select user…', value: '' },
                ...profiles.map((p) => ({ label: p.name ?? p.id, value: p.id })),
              ]"
            />
            <AppButton size="sm" :disabled="!assignUserId" @click="assignOperator">Assign</AppButton>
          </div>
        </AppCard>

        <AppCard title="Notes">
          <p class="registry__notes">{{ aircraft.notes || 'No notes.' }}</p>
        </AppCard>
      </div>

      <form v-else class="edit-form" @submit.prevent="saveEdit">
        <div class="edit-form__row">
          <AppInput v-model="editForm.name" label="Name" />
          <AppInput
            v-model="editForm.status"
            as="select"
            label="Status"
            :options="[
              { label: 'Active', value: 'active' },
              { label: 'Maintenance', value: 'maintenance' },
              { label: 'Retired', value: 'retired' },
            ]"
          />
          <AppInput v-model="editForm.design_rev" label="Design rev" mono />
        </div>
        <AppInput v-model="editForm.notes" as="textarea" label="Notes" />
        <div class="edit-form__actions">
          <AppButton type="submit">Save</AppButton>
          <AppButton variant="ghost" @click="editing = false">Cancel</AppButton>
        </div>
      </form>

      <!-- Component history -->
      <h2>Component history</h2>
      <p class="muted">
        Install/remove events per component — position and reason build the
        provenance record ("front-left motor for 37.2 h").
      </p>
      <AppButton
        v-if="canWriteComp"
        size="sm"
        variant="secondary"
        data-test="add-component-event"
        @click="showCompForm = !showCompForm"
      >
        {{ showCompForm ? 'Close' : '+ Log component event' }}
      </AppButton>

      <form v-if="showCompForm" class="inline-form" @submit.prevent="submitComponentEvent">
        <div class="inline-form__row">
          <AppInput
            v-model="compForm.event"
            as="select"
            label="Event"
            :options="[
              { label: 'Installed', value: 'installed' },
              { label: 'Removed', value: 'removed' },
            ]"
          />
          <AppInput
            v-model="compForm.component_id"
            as="select"
            label="Component"
            :options="[
              { label: '— new component —', value: '' },
              ...components.map((c) => ({
                label: `${c.kind}${c.part_no ? ` · ${c.part_no}` : ''}${c.serial ? ` · ${c.serial}` : ''}`,
                value: c.id,
              })),
            ]"
          />
          <AppInput v-model="compForm.occurred_at" label="When" type="datetime-local" />
        </div>
        <div v-if="!compForm.component_id" class="inline-form__row">
          <AppInput v-model="compForm.newKind" label="New component kind" placeholder="motor / ESC / prop…" />
          <AppInput v-model="compForm.newPartNo" label="Part no" mono />
          <AppInput v-model="compForm.newSerial" label="Serial" mono />
        </div>
        <div class="inline-form__row">
          <AppInput v-model="compForm.position" label="Position" placeholder="front-left" />
          <AppInput v-model="compForm.reason" label="Reason" placeholder="scheduled swap / failure…" />
        </div>
        <div class="inline-form__actions">
          <AppButton type="submit" size="sm">Log event</AppButton>
        </div>
      </form>

      <AppTable :columns="compColumns" :rows="compRows" row-key="id" empty-text="No component events recorded.">
        <template #cell-event="{ value }">
          <AppBadge :variant="value === 'installed' ? 'success' : 'neutral'" square>
            {{ value }}
          </AppBadge>
        </template>
      </AppTable>

      <!-- Airframe events -->
      <h2>Airframe events</h2>
      <AppButton
        v-if="canWrite"
        size="sm"
        variant="secondary"
        data-test="add-airframe-event"
        @click="showEventForm = !showEventForm"
      >
        {{ showEventForm ? 'Close' : '+ Log event' }}
      </AppButton>

      <form v-if="showEventForm" class="inline-form" @submit.prevent="submitAirframeEvent">
        <div class="inline-form__row">
          <AppInput
            v-model="eventForm.kind"
            as="select"
            label="Kind"
            :options="[
              { label: 'Maintenance', value: 'maintenance' },
              { label: 'Incident', value: 'incident' },
              { label: 'Field action', value: 'field_action' },
            ]"
          />
          <AppInput v-model="eventForm.title" label="Title" required />
          <AppInput v-model="eventForm.occurred_at" label="When" type="datetime-local" />
        </div>
        <AppInput v-model="eventForm.body" as="textarea" label="Details" />
        <div class="inline-form__actions">
          <AppButton type="submit" size="sm">Log event</AppButton>
        </div>
      </form>

      <div v-if="airframeEvents.length === 0" class="muted" style="margin-bottom: 1rem">
        No airframe events recorded.
      </div>
      <div class="events">
        <div v-for="ev in airframeEvents" :key="ev.id" class="event">
          <div class="event__head">
            <AppBadge :variant="kindVariant[ev.kind] ?? 'neutral'" square>
              {{ ev.kind.replace('_', ' ') }}
            </AppBadge>
            <strong>{{ ev.title }}</strong>
            <span class="mono-label">{{ fmtDateTime(ev.occurred_at) }}</span>
          </div>
          <p v-if="ev.body" class="event__body">{{ ev.body }}</p>
        </div>
      </div>

      <!-- Flights -->
      <h2>Flights</h2>
      <AppTable
        :columns="flightColumns"
        :rows="flightRows"
        row-key="id"
        clickable
        empty-text="No flights logged for this aircraft."
        @row-click="(row) => router.push(`/flights/${row.id}`)"
      >
        <template #cell-gps="{ value }">
          <AppBadge :variant="value === 'private' ? 'neutral' : 'success'">{{ value }}</AppBadge>
        </template>
      </AppTable>
    </template>
  </AppShell>
</template>

<style scoped>
.registry {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
  margin-bottom: 1.5rem;
}

@media (max-width: 1000px) {
  .registry {
    grid-template-columns: 1fr;
  }
}

.registry__list {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.3rem 1rem;
  margin: 0;
  font-size: 14px;
}

.registry__list dt {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--docs-text-muted);
  align-self: baseline;
}

.registry__list dd {
  margin: 0;
}

.registry__list dd.mono,
.mono {
  font-family: var(--font-mono);
  font-size: 13px;
}

.registry__ops {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.registry__ops li {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 14px;
}

.registry__assign {
  display: flex;
  align-items: flex-end;
  gap: 0.75rem;
  margin-top: 0.9rem;
}

.registry__assign > :first-child {
  flex: 1;
}

.registry__notes {
  margin: 0;
  white-space: pre-wrap;
  font-size: 14px;
}

.muted {
  color: var(--docs-text-muted);
  font-size: 14px;
}

.edit-form,
.inline-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  border: 1px solid var(--docs-border, #d0d9f3);
  background: var(--docs-bg-subtle, #f7f8fa);
  padding: 1rem;
  margin: 0.75rem 0 1.25rem;
}

.edit-form__row,
.inline-form__row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
}

@media (max-width: 900px) {
  .edit-form__row,
  .inline-form__row {
    grid-template-columns: 1fr;
  }
}

.edit-form__actions,
.inline-form__actions {
  display: flex;
  gap: 0.75rem;
}

.events {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}

.event {
  border: 1px solid var(--docs-border-muted, #e5e7eb);
  border-left: 3px solid var(--docs-border, #d0d9f3);
  padding: 0.65rem 0.9rem;
  background: var(--docs-bg);
}

.event__head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.event__body {
  margin: 0.4rem 0 0;
  font-size: 14px;
  white-space: pre-wrap;
  color: var(--docs-text-secondary);
}
</style>
