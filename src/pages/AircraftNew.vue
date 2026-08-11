<script setup lang="ts">
/**
 * /aircraft/new — manufacturer workflow: an airframe is born here.
 * RLS invariant 1: only manufacturers/admins can INSERT aircraft. The form is
 * still reachable by others via URL — on purpose, the submit then surfaces
 * the real RLS denial loudly (the sidebar/fleet button is role-hidden).
 */
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppShell from '../components/AppShell.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppInput from '../components/ui/AppInput.vue';
import AlertBanner from '../components/AlertBanner.vue';
import { isAdmin, isManufacturer } from '../lib/auth';
import { insertRow, selectRows, type Aircraft, type AircraftType } from '../lib/db';
import { supabase } from '../lib/supabase';

const router = useRouter();

const types = ref<AircraftType[]>([]);
const error = ref('');
const busy = ref(false);

const form = ref({
  serial: '',
  name: '',
  type_id: '',
  status: 'active',
  design_rev: '',
  built_at: '',
  notes: '',
});

onMounted(async () => {
  try {
    types.value = await selectRows<AircraftType[]>(
      supabase.from('aircraft_types').select('id,name,class,cells').order('name'),
      'load aircraft types',
    );
    if (types.value.length && !form.value.type_id) {
      form.value.type_id = types.value[0].id;
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    const created = await insertRow<Aircraft>(
      'aircraft',
      {
        serial: form.value.serial.trim(),
        name: form.value.name.trim() || null,
        type_id: form.value.type_id,
        status: form.value.status,
        design_rev: form.value.design_rev.trim() || null,
        built_at: form.value.built_at || null,
        notes: form.value.notes.trim() || null,
      },
      'create aircraft',
    );
    router.push(`/aircraft/${created.id}`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppShell
    :crumbs="[{ label: 'Fleet', to: '/' }, { label: 'Aircraft', to: '/' }, { label: 'New' }]"
    :wide="false"
  >
    <div class="page-header">
      <h1>New aircraft</h1>
      <p class="page-header__description">
        Register an airframe. Only manufacturers can create aircraft records —
        the record is the start of this airframe's provenance history.
      </p>
    </div>

    <AlertBanner
      v-if="!isManufacturer && !isAdmin"
      kind="warning"
      message="Your role cannot create aircraft — only manufacturers register new airframes. Submitting will be rejected."
    />
    <AlertBanner v-if="error" kind="error" :message="error" data-test="create-error" />

    <form class="ac-form" @submit.prevent="submit">
      <div class="ac-form__row">
        <AppInput v-model="form.serial" label="Serial" placeholder="QD-0013" required mono />
        <AppInput v-model="form.name" label="Name" placeholder="Optional callsign / nickname" />
      </div>
      <div class="ac-form__row">
        <AppInput
          v-model="form.type_id"
          as="select"
          label="Type"
          required
          :options="types.map((t) => ({ label: `${t.name} (${t.class === 'fixed_wing' ? 'fixed-wing' : t.cells ? `${t.cells}S ` : ''}${t.class === 'fixed_wing' ? '' : 'multirotor'})`, value: t.id }))"
        />
        <AppInput
          v-model="form.status"
          as="select"
          label="Status"
          :options="[
            { label: 'Active', value: 'active' },
            { label: 'Maintenance', value: 'maintenance' },
            { label: 'Retired', value: 'retired' },
          ]"
        />
      </div>
      <div class="ac-form__row">
        <AppInput v-model="form.design_rev" label="Design rev" placeholder="e.g. rev C" mono />
        <AppInput v-model="form.built_at" label="Built" type="date" />
      </div>
      <AppInput v-model="form.notes" as="textarea" label="Notes" placeholder="Build notes, configuration…" />
      <div class="ac-form__actions">
        <AppButton type="submit" :disabled="busy" data-test="create-aircraft">
          {{ busy ? 'Creating…' : 'Create aircraft' }}
        </AppButton>
        <AppButton variant="ghost" to="/">Cancel</AppButton>
      </div>
    </form>
  </AppShell>
</template>

<style scoped>
.ac-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 640px;
}

.ac-form__row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.ac-form__actions {
  display: flex;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

@media (max-width: 700px) {
  .ac-form__row {
    grid-template-columns: 1fr;
  }
}
</style>
