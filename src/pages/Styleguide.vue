<script setup lang="ts">
/**
 * /styleguide — every design-system component rendered in realistic
 * flight-tracking compositions (fleet cards, flights table, quick-log
 * form, upload pipeline statuses) inside the full app shell.
 */
import { ref } from 'vue';
import AppNavbar from '../components/ui/AppNavbar.vue';
import AppSidebar from '../components/ui/AppSidebar.vue';
import type { SidebarSection } from '../components/ui/AppSidebar.vue';
import AppCard from '../components/ui/AppCard.vue';
import AppTable from '../components/ui/AppTable.vue';
import type { TableColumn } from '../components/ui/AppTable.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppBreadcrumbs from '../components/ui/AppBreadcrumbs.vue';
import AppBadge from '../components/ui/AppBadge.vue';

const sidebarSections: SidebarSection[] = [
  {
    label: 'Fleet',
    items: [
      { label: 'Aircraft', to: '/styleguide', active: true },
      { label: 'Sites', to: '/styleguide#sites' },
      { label: 'Components', to: '/styleguide#components' },
    ],
  },
  {
    label: 'Flights',
    items: [
      { label: 'All flights', to: '/styleguide#flights' },
      { label: 'Quick log', to: '/styleguide#quick-log' },
      { label: 'Bulk upload', to: '/styleguide#bulk' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { label: 'Users & roles', to: '/styleguide#users' },
      { label: 'Audit log', to: '/styleguide#audit' },
      { label: 'Exports', to: '/styleguide#exports' },
    ],
  },
];

const crumbs = [
  { label: 'Fleet', to: '/styleguide' },
  { label: 'Aircraft', to: '/styleguide' },
  { label: 'Styleguide' },
];

// Fleet cards — realistic aircraft entries
const fleet = [
  {
    title: 'Quiver QD-0007',
    body: 'Quiver devkit · Javelina Ranch ops. 42 flights, 18.6 h total.',
    meta: 'OPERATOR: JAVELINA',
    status: 'parsed' as const,
  },
  {
    title: 'Quiver QD-0012',
    body: 'Quiver devkit · PT1 flight-test article. 8 flights, 2.1 h total.',
    meta: 'OPERATOR: ARROW FT',
    status: 'parsing' as const,
  },
  {
    title: 'Caribou C-001',
    body: '18S hex prototype · ground runs only. 0 flights logged.',
    meta: 'MANUFACTURER: ARROW',
    status: 'uploaded' as const,
  },
];

// Flights table
const flightColumns: TableColumn[] = [
  { key: 'id', label: 'Flight', width: '110px', mono: true },
  { key: 'aircraft', label: 'Aircraft' },
  { key: 'site', label: 'Site' },
  { key: 'duration', label: 'Duration', width: '100px', align: 'right', mono: true },
  { key: 'maxAlt', label: 'Max Alt', width: '90px', align: 'right', mono: true },
  { key: 'status', label: 'Log Status', width: '120px' },
  { key: 'gps', label: 'GPS', width: '90px' },
];

const flights = [
  { id: 'FLT-0193', aircraft: 'Quiver QD-0007', site: 'Javelina Ranch', duration: '14:32', maxAlt: '118 m', status: 'parsed', gps: 'private' },
  { id: 'FLT-0192', aircraft: 'Quiver QD-0007', site: 'Javelina Ranch', duration: '09:47', maxAlt: '96 m', status: 'parsing', gps: 'private' },
  { id: 'FLT-0191', aircraft: 'Quiver QD-0012', site: 'PT1 Test Range', duration: '02:52', maxAlt: '41 m', status: 'error', gps: 'shared' },
  { id: 'FLT-0190', aircraft: 'Quiver QD-0012', site: 'PT1 Test Range', duration: '06:11', maxAlt: '77 m', status: 'uploaded', gps: 'shared' },
];

const clickedFlight = ref<string | null>(null);

// Quick-log form model
const form = ref({
  aircraft: 'qd-0007',
  pilot: '',
  site: 'javelina',
  notes: '',
  tailNumber: '',
  gpsPrivate: true,
});

const aircraftOptions = [
  { label: 'Quiver QD-0007', value: 'qd-0007' },
  { label: 'Quiver QD-0012', value: 'qd-0012' },
  { label: 'Caribou C-001', value: 'c-001' },
];

const siteOptions = [
  { label: 'Javelina Ranch — TX', value: 'javelina' },
  { label: 'PT1 Test Range — TX', value: 'pt1' },
];
</script>

<template>
  <div class="app-shell">
    <AppNavbar label="Flight Tracking · Styleguide">
      <template #actions>
        <a class="navbar-action" href="#" @click.prevent>Docs</a>
        <a class="navbar-action is-active" href="#" @click.prevent>Fleet</a>
        <a class="navbar-action" href="#" @click.prevent>
          thomas@arrowair.com
        </a>
      </template>
    </AppNavbar>

    <div class="app-body">
      <AppSidebar :sections="sidebarSections" footer-label="Flight Tracking v2" />

      <main class="app-main">
        <div class="app-content app-content--wide">
          <AppBreadcrumbs :items="crumbs" />

          <div class="page-header">
            <h1>Design system styleguide</h1>
            <p class="page-header__description">
              Every base component, rendered the way the app will use it.
              Ported from the Arrow docs design language.
            </p>
          </div>

          <!-- ============ CARDS ============ -->
          <h2>Cards — fleet grid</h2>
          <p>
            Link cards lift on hover and the bayer dither saturates to blue,
            exactly like the docs landing grid.
          </p>
          <div class="card-grid card-grid--cols-3">
            <AppCard
              v-for="a in fleet"
              :key="a.title"
              :title="a.title"
              to="/styleguide"
            >
              {{ a.body }}
              <template #meta>
                <span>{{ a.meta }}</span>
                <AppBadge :status="a.status" square dot>{{ a.status }}</AppBadge>
              </template>
            </AppCard>
          </div>

          <div class="card-grid card-grid--cols-2">
            <AppCard title="Static card (no link)">
              Cards without a <code>to</code> prop render as plain surfaces:
              no hover lift, no arrow. Use for stat blocks and summaries.
            </AppCard>
            <AppCard>
              <template #title>
                Battery health <AppBadge variant="warning">sag 0.42 V</AppBadge>
              </template>
              Slotted titles can mix in badges and custom markup.
            </AppCard>
          </div>

          <!-- ============ TABLE ============ -->
          <h2 id="flights">Table — recent flights</h2>
          <p>
            Blue header band with Departure&nbsp;Mono labels, condensed
            bordered cells. Rows are clickable here.
            <template v-if="clickedFlight">
              Last clicked: <code>{{ clickedFlight }}</code>
            </template>
          </p>
          <AppTable
            :columns="flightColumns"
            :rows="flights"
            row-key="id"
            clickable
            @row-click="(row) => (clickedFlight = String(row.id))"
          >
            <template #cell-status="{ value }">
              <AppBadge :status="value as any" square dot>{{ value }}</AppBadge>
            </template>
            <template #cell-gps="{ value }">
              <AppBadge :variant="value === 'private' ? 'neutral' : 'success'">
                {{ value }}
              </AppBadge>
            </template>
          </AppTable>

          <h3>Empty state</h3>
          <AppTable
            :columns="flightColumns.slice(0, 4)"
            :rows="[]"
            empty-text="No flights yet — upload a .BIN log to get started."
          />

          <!-- ============ BUTTONS ============ -->
          <h2>Buttons</h2>
          <p>
            Square corners, mono allcaps, hard offset shadow that presses in
            on click. Hold a click to feel the active state.
          </p>
          <div class="row">
            <AppButton variant="primary">Log flight</AppButton>
            <AppButton variant="secondary">Export CSV</AppButton>
            <AppButton variant="ghost">Cancel</AppButton>
            <AppButton variant="danger">Delete log</AppButton>
            <AppButton variant="primary" disabled>Disabled</AppButton>
          </div>
          <div class="row">
            <AppButton variant="primary" size="sm">Upload .BIN</AppButton>
            <AppButton variant="secondary" size="sm">
              <template #icon>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                  <path
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="square"
                    d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16"
                  />
                </svg>
              </template>
              Download
            </AppButton>
            <AppButton variant="ghost" size="sm">View raw</AppButton>
          </div>

          <!-- ============ FORMS ============ -->
          <h2 id="quick-log">Form controls — quick log</h2>
          <p>
            Mono allcaps labels (docs H5 treatment), square inputs, blue
            focus ring. Tab through to check focus states.
          </p>
          <form class="panel" @submit.prevent>
            <div class="panel__titlebar">Quick log — new flight</div>
            <div class="panel__body form-grid">
              <AppInput
                as="select"
                label="Aircraft"
                required
                :options="aircraftOptions"
                v-model="form.aircraft"
              />
              <AppInput
                label="Pilot"
                placeholder="Pilot in command"
                required
                v-model="form.pilot"
              />
              <AppInput
                as="select"
                label="Site"
                :options="siteOptions"
                v-model="form.site"
              />
              <AppInput
                label="Tail number"
                placeholder="QD-0007"
                mono
                hint="Registry ID as printed on the airframe."
                v-model="form.tailNumber"
              />
              <div class="form-grid__full">
                <AppInput
                  as="textarea"
                  label="Notes"
                  placeholder="Weather, anomalies, maintenance observations…"
                  :rows="3"
                  v-model="form.notes"
                />
              </div>
              <AppInput
                as="checkbox"
                label="Keep GPS track private"
                v-model="form.gpsPrivate"
              />
              <AppInput
                label="Battery ID"
                placeholder="e.g. BAT-2207-A"
                mono
                error="Unknown battery ID — not found in components."
                model-value="BAT-9999"
              />
              <div class="form-grid__full row row--end">
                <AppButton variant="ghost">Cancel</AppButton>
                <AppButton variant="primary" type="submit">
                  Save flight
                </AppButton>
              </div>
            </div>
          </form>

          <!-- ============ BADGES ============ -->
          <h2>Badges</h2>
          <h3>Pipeline statuses (square mono)</h3>
          <div class="row">
            <AppBadge status="uploaded" square dot>uploaded</AppBadge>
            <AppBadge status="parsing" square dot>parsing</AppBadge>
            <AppBadge status="parsed" square dot>parsed</AppBadge>
            <AppBadge status="error" square dot>error</AppBadge>
          </div>
          <h3>Pills (docs voting table)</h3>
          <div class="row">
            <AppBadge variant="success">pass</AppBadge>
            <AppBadge variant="danger">rejected</AppBadge>
            <AppBadge variant="warning">no quorum</AppBadge>
            <AppBadge variant="info">info</AppBadge>
            <AppBadge variant="neutral">neutral</AppBadge>
            <AppBadge variant="primary">manufacturer</AppBadge>
          </div>

          <!-- ============ BREADCRUMBS ============ -->
          <h2>Breadcrumbs</h2>
          <AppBreadcrumbs
            :items="[
              { label: 'Fleet', to: '/styleguide' },
              { label: 'Quiver QD-0007', to: '/styleguide' },
              { label: 'FLT-0193' },
            ]"
          />

          <!-- ============ TYPOGRAPHY ============ -->
          <h2>Typography & base elements</h2>
          <h3>Subsection heading (H3)</h3>
          <h4>Mono label heading (H4)</h4>
          <h5>Sublabel (H5)</h5>
          <h6>Fine print label (H6)</h6>
          <p>
            Body text in Neue Haas Grotesk with
            <strong>strong emphasis</strong>, <em>italics</em>, an
            <a href="#" @click.prevent>inline link</a>, inline
            <code>flight_logs.status</code> code, and a keyboard shortcut
            <kbd>⌘K</kbd>.
          </p>
          <blockquote>
            Blockquote — GPS tracks are private by default; admins and the
            owning operator see raw data, everyone else gets sanitized
            artifacts.
          </blockquote>
          <pre><code>$ supabase db reset
Resetting local database…
Applying migration 0001_core_schema.sql…</code></pre>

          <div class="panel" style="margin-top: 1.5rem">
            <div class="panel__titlebar">Parser status</div>
            <div class="panel__body">
              Panels reuse the docs admonition frame: hard shadow, mono
              titlebar with window controls.
            </div>
          </div>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
  margin: 0 0 1rem 0;
}

.row--end {
  justify-content: flex-end;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem 1.5rem;
  padding: 1.25rem 1.5rem;
}

.form-grid__full {
  grid-column: 1 / -1;
}

@media (max-width: 768px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
