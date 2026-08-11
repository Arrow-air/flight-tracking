<script setup lang="ts">
/**
 * /sites — sites CRUD. Coordinates power the quick-log Open-Meteo weather
 * auto-fill, so missing lat/lon is called out per row.
 */
import { computed, onMounted, ref } from 'vue';
import AppShell from '../components/AppShell.vue';
import AppBadge from '../components/ui/AppBadge.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppTable from '../components/ui/AppTable.vue';
import type { TableColumn } from '../components/ui/AppTable.vue';
import AlertBanner from '../components/AlertBanner.vue';
import { isAdmin, userId } from '../lib/auth';
import { deleteRow, insertRow, selectRows, updateRow, type Site } from '../lib/db';
import { supabase } from '../lib/supabase';

const sites = ref<Site[]>([]);
const loading = ref(true);
const error = ref('');
const notice = ref('');

const editingId = ref<string | null>(null); // null = closed, '' = new
const showForm = ref(false);
const form = ref({
  name: '',
  lat: '',
  lon: '',
  elevation_m: '',
  notes: '',
  visibility: 'private' as 'private' | 'public',
});

function resetForm() {
  form.value = { name: '', lat: '', lon: '', elevation_m: '', notes: '', visibility: 'private' };
}

function openNew() {
  resetForm();
  editingId.value = '';
  showForm.value = true;
}

function openEdit(site: Site) {
  form.value = {
    name: site.name,
    lat: site.lat != null ? String(site.lat) : '',
    lon: site.lon != null ? String(site.lon) : '',
    elevation_m: site.elevation_m != null ? String(site.elevation_m) : '',
    notes: site.notes ?? '',
    visibility: site.visibility,
  };
  editingId.value = site.id;
  showForm.value = true;
}

function numOrNull(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) throw new Error(`"${t}" is not a number`);
  return n;
}

async function submit() {
  error.value = '';
  notice.value = '';
  try {
    const values = {
      name: form.value.name.trim(),
      lat: numOrNull(form.value.lat),
      lon: numOrNull(form.value.lon),
      elevation_m: numOrNull(form.value.elevation_m),
      notes: form.value.notes.trim() || null,
      visibility: form.value.visibility,
    };
    if (editingId.value) {
      await updateRow('sites', editingId.value, values, 'update site');
      notice.value = 'Site updated.';
    } else {
      await insertRow('sites', values, 'create site');
      notice.value = 'Site created.';
    }
    showForm.value = false;
    editingId.value = null;
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function remove(site: Site) {
  error.value = '';
  notice.value = '';
  if (!window.confirm(`Delete site "${site.name}"?`)) return;
  try {
    await deleteRow('sites', site.id, `delete site ${site.name}`);
    notice.value = 'Site deleted.';
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function load() {
  sites.value = await selectRows<Site[]>(
    supabase.from('sites').select('*').order('name'),
    'load sites',
  );
}

onMounted(async () => {
  try {
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});

const columns: TableColumn[] = [
  { key: 'name', label: 'Site' },
  { key: 'coords', label: 'Coordinates', width: '220px', mono: true },
  { key: 'elevation', label: 'Elev', width: '80px', align: 'right', mono: true },
  { key: 'visibility', label: 'Visibility', width: '110px' },
  { key: 'notes', label: 'Notes' },
  { key: 'actions', label: '', width: '150px', align: 'right' },
];

const rows = computed(() =>
  sites.value.map((s) => ({
    id: s.id,
    name: s.name,
    coords: s.lat != null && s.lon != null ? `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}` : 'no coords',
    elevation: s.elevation_m != null ? `${s.elevation_m} m` : '—',
    visibility: s.visibility,
    notes: s.notes ?? '—',
    _site: s,
  })),
);

function canEdit(s: Site): boolean {
  return isAdmin.value || s.created_by === userId.value;
}
</script>

<template>
  <AppShell :crumbs="[{ label: 'Fleet' }, { label: 'Sites' }]">
    <div class="page-header">
      <h1>Sites</h1>
      <p class="page-header__description">
        Flying locations as first-class records. Coordinates feed the
        quick-log weather auto-fill (Open-Meteo) — fill them in.
      </p>
    </div>

    <AlertBanner v-if="error" kind="error" :message="error" />
    <AlertBanner v-if="notice" kind="success" :message="notice" />

    <div class="sites-actions">
      <AppButton data-test="new-site" @click="openNew">+ New site</AppButton>
    </div>

    <form v-if="showForm" class="site-form" @submit.prevent="submit">
      <div class="site-form__row">
        <AppInput v-model="form.name" label="Name" required placeholder="Javelina (TX ops)" />
        <AppInput
          v-model="form.visibility"
          as="select"
          label="Visibility"
          :options="[
            { label: 'Private', value: 'private' },
            { label: 'Public', value: 'public' },
          ]"
        />
      </div>
      <div class="site-form__row site-form__row--3">
        <AppInput v-model="form.lat" label="Latitude" mono placeholder="27.51234" hint="Decimal degrees" />
        <AppInput v-model="form.lon" label="Longitude" mono placeholder="-98.12345" />
        <AppInput v-model="form.elevation_m" label="Elevation (m)" mono placeholder="120" />
      </div>
      <AppInput v-model="form.notes" as="textarea" label="Notes" :rows="2" />
      <div class="site-form__actions">
        <AppButton type="submit" size="sm">{{ editingId ? 'Save site' : 'Create site' }}</AppButton>
        <AppButton size="sm" variant="ghost" @click="showForm = false; editingId = null">Cancel</AppButton>
      </div>
    </form>

    <p v-if="loading">Loading sites…</p>
    <AppTable v-else :columns="columns" :rows="rows" row-key="id" empty-text="No sites yet.">
      <template #cell-coords="{ value }">
        <AppBadge v-if="value === 'no coords'" variant="warning" square>no coords</AppBadge>
        <template v-else>{{ value }}</template>
      </template>
      <template #cell-visibility="{ value }">
        <AppBadge :variant="value === 'public' ? 'success' : 'neutral'">{{ value }}</AppBadge>
      </template>
      <template #cell-actions="{ row }">
        <span v-if="canEdit((row as any)._site)" class="row-actions">
          <AppButton size="sm" variant="ghost" @click="openEdit((row as any)._site)">Edit</AppButton>
          <AppButton size="sm" variant="ghost" @click="remove((row as any)._site)">Delete</AppButton>
        </span>
      </template>
    </AppTable>
  </AppShell>
</template>

<style scoped>
.sites-actions {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 1rem;
}

.site-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  border: 1px solid var(--docs-border, #d0d9f3);
  background: var(--docs-bg-subtle, #f7f8fa);
  padding: 1rem;
  margin-bottom: 1.25rem;
}

.site-form__row {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 1rem;
}

.site-form__row--3 {
  grid-template-columns: 1fr 1fr 1fr;
}

@media (max-width: 800px) {
  .site-form__row,
  .site-form__row--3 {
    grid-template-columns: 1fr;
  }
}

.site-form__actions {
  display: flex;
  gap: 0.75rem;
}

.row-actions {
  display: inline-flex;
  gap: 0.25rem;
}
</style>
