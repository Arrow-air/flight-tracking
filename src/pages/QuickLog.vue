<script setup lang="ts">
/**
 * /flights/new — one-screen quick-log: aircraft / pilot / site / times /
 * notes / tags, Open-Meteo weather auto-fill (site coords + start time,
 * keyless), optional .bin log attach that rides the same upload pipeline.
 *
 * Aircraft options honour the control edge: admins see all, operators see
 * only aircraft they're assigned to (RLS would reject the rest anyway —
 * the UI mirrors it instead of letting you hit the wall).
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppShell from '../components/AppShell.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppInput from '../components/ui/AppInput.vue';
import AlertBanner from '../components/AlertBanner.vue';
import { auth, isAdmin, userId } from '../lib/auth';
import {
  insertRow,
  selectRows,
  type Aircraft,
  type Flight,
  type Profile,
  type Site,
  type Tag,
} from '../lib/db';
import { supabase } from '../lib/supabase';
import { toDatetimeLocal, fromDatetimeLocal } from '../lib/format';
import { extractLogInfo, sha256Hex } from '../lib/binlog';
import { uploadFlightLog, findLogByChecksum, DuplicateLogError } from '../lib/logs';
import { fetchWeatherAt, weatherLine, type WeatherSnapshot } from '../lib/weather';

const router = useRouter();

const aircraft = ref<Aircraft[]>([]);
const sites = ref<Site[]>([]);
const profiles = ref<Profile[]>([]);
const loading = ref(true);
const error = ref('');
const busy = ref(false);
const busyStep = ref('');

const form = ref({
  aircraft_id: '',
  pilot_id: '',
  site_id: '',
  // F3: optional — leave as-is or clear it; the parser's log-derived
  // start_time_utc wins on display once the log is parsed.
  started_at: toDatetimeLocal(new Date()),
  title: '',
  notes: '',
  tags: '',
  gps_private: true,
});

const logFile = ref<File | null>(null);
const logChecksum = ref<string | null>(null);
const logTimeNote = ref('');
// F1: pre-upload duplicate detection (checksum lookup before any upload)
const dupFlightId = ref<string | null>(null);
// D1: COARSE takeoff coordinate read from the log head (2 dp, ~1.1 km) —
// weather auto-fill prefers it over the site's coordinates.
const logCoords = ref<{ lat: number; lon: number } | null>(null);

// weather
const weather = ref<WeatherSnapshot | null>(null);
const weatherError = ref('');
const weatherBusy = ref(false);
const weatherCoordSource = ref<'log' | 'site' | null>(null);
let weatherSeq = 0; // drop out-of-order responses (site/time changed mid-fetch)

const writableAircraft = computed(() =>
  isAdmin.value
    ? aircraft.value
    : aircraft.value.filter((a) => auth.operatorOf.includes(a.id)),
);

const selectedSite = computed(() =>
  sites.value.find((s) => s.id === form.value.site_id) ?? null,
);

const siteHasCoords = computed(
  () => selectedSite.value?.lat != null && selectedSite.value?.lon != null,
);

onMounted(async () => {
  try {
    [aircraft.value, sites.value, profiles.value] = await Promise.all([
      selectRows<Aircraft[]>(
        supabase.from('aircraft').select('*, aircraft_types(name)').order('serial'),
        'load aircraft',
      ),
      // F2: sites have no operator edge in the schema — RLS already scopes
      // this select to own + public (+ admin), so the dropdown is filtered
      // server-side. Aircraft are scoped via writableAircraft above.
      selectRows<Site[]>(supabase.from('sites').select('*').order('name'), 'load sites'),
      selectRows<Profile[]>(
        supabase.from('user_profiles').select('id,name,roles,gps_default_private').order('name'),
        'load pilots',
      ),
    ]);
    form.value.pilot_id = userId.value ?? '';
    form.value.gps_private = auth.profile?.gps_default_private ?? true;
    if (writableAircraft.value.length === 1) {
      form.value.aircraft_id = writableAircraft.value[0].id;
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});

async function onFilePicked(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const f = input.files?.[0] ?? null;
  logFile.value = f;
  logChecksum.value = null;
  logTimeNote.value = '';
  dupFlightId.value = null;
  logCoords.value = null;
  if (!f) return;

  // F1: hash + look up the checksum BEFORE anything is created/uploaded.
  // Re-picking a file while these awaits are in flight makes this run
  // stale — guard every state write on logFile still being OUR file, or
  // a slow hash of the old file would attach its checksum (and dup
  // verdict) to the newly picked one.
  const checksum = await sha256Hex(f);
  if (logFile.value !== f) return;
  const existing = await findLogByChecksum(checksum);
  if (logFile.value !== f) return;
  if (existing) {
    logFile.value = null;
    input.value = '';
    dupFlightId.value = existing.flight_id;
    logTimeNote.value = `${f.name} was already uploaded (checksum ${checksum.slice(0, 12)}…) — duplicate skipped.`;
    return;
  }
  logChecksum.value = checksum;

  const { time, source, lat, lon } = await extractLogInfo(f);
  if (logFile.value !== f) return;
  form.value.started_at = toDatetimeLocal(time);
  logCoords.value = lat != null && lon != null ? { lat, lon } : null;
  logTimeNote.value =
    source === 'gps'
      ? `Start time read from the log's GPS clock (${time.toLocaleString()}).` +
        (logCoords.value
          ? ' Takeoff coordinates found — weather will use them.'
          : '')
      : `No GPS time found in the log head — using the file's modified time (${time.toLocaleString()}). The parser will refine it.`;
  void autofillWeather();
}

async function autofillWeather() {
  weather.value = null;
  weatherError.value = '';
  weatherCoordSource.value = null;
  // D1: the log's coarse takeoff coordinate wins; site coords are fallback.
  const site = selectedSite.value;
  const coords = logCoords.value
    ? { ...logCoords.value, source: 'log' as const }
    : site && site.lat != null && site.lon != null
      ? { lat: site.lat, lon: site.lon, source: 'site' as const }
      : null;
  if (!coords) {
    weatherError.value =
      'No coordinates available — attach a log with GPS or pick a site with coordinates (Sites page).';
    return;
  }
  const when = form.value.started_at ? new Date(form.value.started_at) : null;
  if (!when || Number.isNaN(when.getTime())) {
    weatherError.value = 'Set a start time first.';
    return;
  }
  weatherBusy.value = true;
  const seq = ++weatherSeq;
  try {
    const snap = await fetchWeatherAt(coords.lat, coords.lon, when);
    if (seq !== weatherSeq) return; // a newer fetch superseded this one
    if (!snap) {
      weatherError.value = 'Open-Meteo returned no data for that time/place.';
      return;
    }
    weather.value = snap;
    weatherCoordSource.value = coords.source;
  } catch (e) {
    if (seq !== weatherSeq) return;
    weatherError.value = `Weather lookup failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    if (seq === weatherSeq) weatherBusy.value = false;
  }
}

// re-fetch automatically once both inputs exist
watch(
  () => [form.value.site_id, form.value.started_at],
  () => {
    if ((logCoords.value || siteHasCoords.value) && form.value.started_at) {
      void autofillWeather();
    }
  },
);

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    if (!form.value.aircraft_id) throw new Error('Pick an aircraft.');
    busyStep.value = 'Saving flight…';

    // Weather rides in the notes (ASSUMPTION documented in the round log:
    // no dedicated weather column on flights; parser-side wind lands in
    // flight_log_summary.wind later).
    let notes = form.value.notes.trim();
    if (weather.value) {
      notes = notes ? `${notes}\n\n${weatherLine(weather.value)}` : weatherLine(weather.value);
    }

    const flight = await insertRow<Flight>('flights', {
      aircraft_id: form.value.aircraft_id,
      pilot_id: form.value.pilot_id || null,
      site_id: form.value.site_id || null,
      started_at: fromDatetimeLocal(form.value.started_at),
      title: form.value.title.trim() || null,
      notes: notes || null,
      gps_private: form.value.gps_private,
    }, 'create flight');

    // tags: comma-separated → upsert tag names, link
    const tagNames = form.value.tags
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    for (const name of tagNames) {
      const { data: existing } = await supabase
        .from('tags')
        .select('id')
        .eq('name', name)
        .maybeSingle();
      let tagId = (existing as Tag | null)?.id;
      if (!tagId) {
        const created = await insertRow<Tag>('tags', { name }, `create tag "${name}"`);
        tagId = created.id;
      }
      const { error: linkErr } = await supabase
        .from('flight_tags')
        .insert({ flight_id: flight.id, tag_id: tagId });
      if (linkErr && linkErr.code !== '23505') {
        throw new Error(`tag "${name}": ${linkErr.message}`);
      }
    }

    if (logFile.value) {
      busyStep.value = `Uploading ${logFile.value.name}…`;
      try {
        await uploadFlightLog(flight.id, logFile.value, logChecksum.value ?? undefined);
      } catch (e) {
        if (e instanceof DuplicateLogError) {
          error.value = `Flight saved, but the log was skipped: ${e.message}`;
          router.push(`/flights/${flight.id}`);
          return;
        }
        throw e;
      }
    }
    router.push(`/flights/${flight.id}`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
    busyStep.value = '';
  }
}
</script>

<template>
  <AppShell :crumbs="[{ label: 'Flights', to: '/flights' }, { label: 'Quick log' }]" :wide="false">
    <div class="page-header">
      <h1>Quick log</h1>
      <p class="page-header__description">
        One screen, no ceremony: log the flight, drop the log file on it,
        weather fills itself in from the site + time.
      </p>
    </div>

    <AlertBanner v-if="error" kind="error" :message="error" data-test="quicklog-error" />
    <AlertBanner
      v-if="!loading && writableAircraft.length === 0"
      kind="warning"
      message="You are not assigned as operator of any aircraft, so you cannot log flights yet. Ask a manufacturer/admin for an assignment."
    />

    <form class="ql-form" @submit.prevent="submit">
      <div class="ql-form__row">
        <AppInput
          v-model="form.aircraft_id"
          as="select"
          label="Aircraft"
          required
          :options="[
            { label: 'Select aircraft…', value: '' },
            ...writableAircraft.map((a) => ({
              label: `${a.name || a.serial} (${a.aircraft_types?.name ?? '?'} · ${a.serial})`,
              value: a.id,
            })),
          ]"
        />
        <AppInput
          v-model="form.pilot_id"
          as="select"
          label="Pilot"
          :options="[
            { label: '—', value: '' },
            ...profiles.map((p) => ({ label: p.name ?? p.id, value: p.id })),
          ]"
        />
      </div>

      <div class="ql-form__row">
        <AppInput
          v-model="form.site_id"
          as="select"
          label="Site"
          :options="[
            { label: '—', value: '' },
            ...sites.map((s) => ({
              label: s.lat != null ? s.name : `${s.name} (no coords)`,
              value: s.id,
            })),
          ]"
        />
        <AppInput v-model="form.title" label="Title" placeholder="e.g. Morning spray run #2" />
      </div>

      <div class="ql-form__row">
        <AppInput
          v-model="form.started_at"
          label="Started"
          type="datetime-local"
          hint="Optional — the log's own clock takes precedence once parsed"
        />
      </div>

      <!-- log attach -->
      <div class="ql-file">
        <label class="ql-file__label" for="ql-log">DataFlash log (.bin, optional)</label>
        <input id="ql-log" type="file" accept=".bin,.BIN" @change="onFilePicked" />
        <p v-if="logTimeNote" class="ql-file__note" :class="{ 'ql-file__note--warn': dupFlightId }">
          {{ logTimeNote }}
          <router-link v-if="dupFlightId" :to="`/flights/${dupFlightId}`">
            Open the flight it belongs to →
          </router-link>
        </p>
      </div>

      <!-- weather -->
      <div class="ql-weather">
        <div class="ql-weather__head">
          <span class="ql-weather__title">Weather auto-fill</span>
          <AppButton
            size="sm"
            variant="secondary"
            :disabled="weatherBusy || (!logCoords && !siteHasCoords) || !form.started_at"
            data-test="fetch-weather"
            @click="autofillWeather"
          >
            {{ weatherBusy ? 'Fetching…' : 'Fetch weather' }}
          </AppButton>
        </div>
        <p v-if="weather" class="ql-weather__result" data-test="weather-result">
          {{ weatherLine(weather) }}
          <span class="ql-weather__source">
            source: {{ weather.source }}
            <template v-if="weatherCoordSource">
              at {{ weatherCoordSource === 'log' ? 'log takeoff coordinates (coarse)' : 'site coordinates' }}
            </template>
            — saved into the flight notes
          </span>
        </p>
        <p v-else-if="weatherError" class="ql-weather__error">{{ weatherError }}</p>
        <p v-else class="ql-weather__hint">
          Attach a log with GPS (its coarse takeoff coordinates win) or pick a
          site with coordinates, plus a start time — conditions come from
          Open-Meteo (keyless) and get appended to the notes.
        </p>
      </div>

      <AppInput v-model="form.notes" as="textarea" label="Notes" :rows="3" placeholder="What happened?" />
      <AppInput v-model="form.tags" label="Tags" placeholder="ag-ops, spray, test (comma-separated)" mono />
      <AppInput
        v-model="form.gps_private"
        as="checkbox"
        label="GPS private (only you and admins see raw location data)"
      />

      <div class="ql-form__actions">
        <AppButton type="submit" :disabled="busy" data-test="save-flight">
          {{ busy ? busyStep || 'Saving…' : 'Save flight' }}
        </AppButton>
        <AppButton variant="ghost" to="/flights">Cancel</AppButton>
      </div>
    </form>
  </AppShell>
</template>

<style scoped>
.ql-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 680px;
}

.ql-form__row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

@media (max-width: 760px) {
  .ql-form__row {
    grid-template-columns: 1fr;
  }
}

.ql-form__actions {
  display: flex;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.ql-file {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.ql-file__label {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--docs-primary);
}

.ql-file input[type='file'] {
  font-family: var(--font-mono);
  font-size: 13px;
  padding: 0.5rem;
  border: 1px dashed var(--docs-border, #d0d9f3);
  background: var(--docs-bg-subtle, #f7f8fa);
}

.ql-file__note {
  margin: 0;
  font-size: 12px;
  color: var(--docs-text-muted);
}

.ql-file__note--warn {
  color: #b45309;
}

.ql-weather {
  border: 1px solid var(--docs-border, #d0d9f3);
  background: var(--docs-primary-light, rgba(8, 67, 191, 0.08));
  padding: 0.85rem 1rem;
}

.ql-weather__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.ql-weather__title {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--docs-primary);
}

.ql-weather__result {
  margin: 0.6rem 0 0;
  font-size: 14px;
}

.ql-weather__source {
  display: block;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--docs-text-muted);
  margin-top: 0.25rem;
}

.ql-weather__error {
  margin: 0.6rem 0 0;
  font-size: 13px;
  color: #b45309;
}

.ql-weather__hint {
  margin: 0.6rem 0 0;
  font-size: 13px;
  color: var(--docs-text-muted);
}
</style>
