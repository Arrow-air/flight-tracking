<script setup lang="ts">
/**
 * /admin — B1: manage users' roles + per-aircraft operator access grants.
 *
 * Gating is layered:
 *  1. RLS (the real gate): guard_roles trigger + user_profiles/
 *     aircraft_operators policies — a non-admin calling these APIs gets a
 *     thrown permission error, never a silent success.
 *  2. Route guard: /admin has meta.adminOnly, enforced in router.ts.
 *  3. This page re-checks isAdmin and renders a denial banner (defense in
 *     depth if navigation raced a profile refresh).
 *
 * Emails are NOT shown: auth.users is not client-readable by design; the UI
 * shows profile name + user id.
 */
import { computed, onMounted, ref } from 'vue';
import AlertBanner from '../components/AlertBanner.vue';
import AppShell from '../components/AppShell.vue';
import AppBadge from '../components/ui/AppBadge.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppTable from '../components/ui/AppTable.vue';
import type { TableColumn } from '../components/ui/AppTable.vue';
import {
  ALL_ROLES,
  aircraftLabel,
  grantAircraft,
  grantableAircraft,
  grantsForUser,
  listAircraftOptions,
  listGrants,
  listUsers,
  removesOwnAdmin,
  revokeAircraft,
  setUserRoles,
  sortRoles,
  type AircraftOption,
  type OperatorGrant,
} from '../lib/admin';
import { isAdmin, refreshProfile, userId } from '../lib/auth';
import type { Profile, Role } from '../lib/db';

const users = ref<Profile[]>([]);
const aircraft = ref<AircraftOption[]>([]);
const grants = ref<OperatorGrant[]>([]);
const loading = ref(true);
const error = ref('');
const notice = ref('');

// --- manage panel state ---
const selectedId = ref<string | null>(null);
const roleDraft = ref<Role[]>([]);
const savingRoles = ref(false);
const grantPick = ref('');
const granting = ref(false);

const selectedUser = computed(
  () => users.value.find((u) => u.id === selectedId.value) ?? null,
);

const selectedGrants = computed(() =>
  selectedId.value ? grantsForUser(grants.value, selectedId.value) : [],
);

const grantOptions = computed(() => {
  if (!selectedId.value) return [];
  return grantableAircraft(aircraft.value, grants.value, selectedId.value).map(
    (a) => ({ label: aircraftLabel(a), value: a.id }),
  );
});

const roleDraftBlocked = computed(
  () =>
    selectedId.value != null &&
    removesOwnAdmin(userId.value, selectedId.value, roleDraft.value),
);

const aircraftById = computed(() => {
  const m = new Map<string, AircraftOption>();
  for (const a of aircraft.value) m.set(a.id, a);
  return m;
});

function openManage(user: Profile) {
  notice.value = '';
  error.value = '';
  selectedId.value = user.id;
  roleDraft.value = sortRoles(user.roles);
  grantPick.value = '';
}

function closeManage() {
  selectedId.value = null;
}

function draftHas(role: Role): boolean {
  return roleDraft.value.includes(role);
}

function setDraft(role: Role, on: boolean) {
  const next = roleDraft.value.filter((r) => r !== role);
  if (on) next.push(role);
  roleDraft.value = sortRoles(next);
}

async function load() {
  const [u, a, g] = await Promise.all([
    listUsers(),
    listAircraftOptions(),
    listGrants(),
  ]);
  users.value = u;
  aircraft.value = a;
  grants.value = g;
}

async function saveRoles() {
  if (!selectedUser.value) return;
  error.value = '';
  notice.value = '';
  if (roleDraftBlocked.value) {
    error.value =
      'Refusing to remove your own admin role — you would lock yourself out. Ask another admin.';
    return;
  }
  savingRoles.value = true;
  try {
    await setUserRoles(selectedUser.value.id, roleDraft.value);
    notice.value = `Roles updated for ${selectedUser.value.name ?? selectedUser.value.id}.`;
    await load();
    if (selectedUser.value.id === userId.value) await refreshProfile();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    savingRoles.value = false;
  }
}

async function addGrant() {
  if (!selectedId.value || !grantPick.value) return;
  error.value = '';
  notice.value = '';
  granting.value = true;
  try {
    await grantAircraft(grantPick.value, selectedId.value);
    notice.value = 'Aircraft access granted.';
    grantPick.value = '';
    grants.value = await listGrants();
    if (selectedId.value === userId.value) await refreshProfile();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    granting.value = false;
  }
}

async function removeGrant(g: OperatorGrant) {
  const label = aircraftById.value.get(g.aircraft_id);
  const name = label ? aircraftLabel(label) : g.aircraft_id;
  if (!window.confirm(`Revoke access to ${name}?`)) return;
  error.value = '';
  notice.value = '';
  try {
    await revokeAircraft(g.aircraft_id, g.user_id);
    notice.value = 'Aircraft access revoked.';
    grants.value = await listGrants();
    if (g.user_id === userId.value) await refreshProfile();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(async () => {
  if (!isAdmin.value) {
    loading.value = false;
    return;
  }
  try {
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});

const columns: TableColumn[] = [
  { key: 'name', label: 'User' },
  { key: 'uid', label: 'User ID', width: '130px', mono: true },
  { key: 'roles', label: 'Roles', width: '240px' },
  { key: 'access', label: 'Aircraft access', width: '150px' },
  { key: 'actions', label: '', width: '110px', align: 'right' },
];

const rows = computed(() =>
  users.value.map((u) => ({
    id: u.id,
    name: u.name ?? '(no name)',
    uid: `${u.id.slice(0, 8)}…`,
    roles: sortRoles(u.roles),
    access: grantsForUser(grants.value, u.id).length,
    _user: u,
  })),
);

const roleVariant: Record<Role, 'primary' | 'info' | 'neutral'> = {
  admin: 'primary',
  manufacturer: 'info',
  operator: 'neutral',
};

const roleHint: Record<Role, string> = {
  admin: 'Full access everywhere, including this page.',
  manufacturer: 'Can create aircraft and assign operators.',
  operator: 'Writes flights/maintenance only on granted aircraft.',
};
</script>

<template>
  <AppShell :crumbs="[{ label: 'Admin' }, { label: 'Users & access' }]">
    <div class="page-header">
      <h1>Users &amp; access</h1>
      <p class="page-header__description">
        Assign roles and grant per-aircraft operator access. Changes are
        enforced server-side (RLS) — this page is the admin front door, not the
        lock.
      </p>
    </div>

    <AlertBanner
      v-if="!isAdmin"
      kind="error"
      message="Admins only. Your role does not allow user management."
    />

    <template v-else>
      <AlertBanner v-if="error" kind="error" :message="error" />
      <AlertBanner v-if="notice" kind="success" :message="notice" />

      <div v-if="selectedUser" class="manage" data-test="manage-panel">
        <div class="manage__head">
          <h2 class="manage__title">
            {{ selectedUser.name ?? '(no name)' }}
            <span class="manage__id">{{ selectedUser.id }}</span>
          </h2>
          <AppButton size="sm" variant="ghost" @click="closeManage">Close</AppButton>
        </div>

        <div class="manage__grid">
          <section>
            <h3 class="manage__section">Roles</h3>
            <div class="manage__roles">
              <div v-for="role in ALL_ROLES" :key="role" class="manage__role">
                <AppInput
                  as="checkbox"
                  :label="role"
                  :model-value="draftHas(role)"
                  :disabled="role === 'admin' && selectedUser.id === userId"
                  @update:model-value="setDraft(role, $event === true)"
                />
                <p class="manage__role-hint">
                  {{ role === 'admin' && selectedUser.id === userId
                    ? 'You cannot remove your own admin role.'
                    : roleHint[role] }}
                </p>
              </div>
            </div>
            <AppButton
              size="sm"
              data-test="save-roles"
              :disabled="savingRoles || roleDraftBlocked"
              @click="saveRoles"
            >
              {{ savingRoles ? 'Saving…' : 'Save roles' }}
            </AppButton>
          </section>

          <section>
            <h3 class="manage__section">Aircraft access</h3>
            <p v-if="selectedGrants.length === 0" class="manage__empty">
              No aircraft granted.
            </p>
            <ul v-else class="manage__grants">
              <li v-for="g in selectedGrants" :key="g.aircraft_id" class="manage__grant">
                <span class="manage__grant-label">
                  {{ aircraftById.get(g.aircraft_id)
                    ? aircraftLabel(aircraftById.get(g.aircraft_id)!)
                    : g.aircraft_id }}
                </span>
                <AppButton size="sm" variant="ghost" @click="removeGrant(g)">
                  Revoke
                </AppButton>
              </li>
            </ul>
            <div class="manage__add">
              <AppInput
                v-model="grantPick"
                as="select"
                label="Grant aircraft"
                :options="grantOptions"
                :disabled="grantOptions.length === 0"
              />
              <AppButton
                size="sm"
                data-test="grant-aircraft"
                :disabled="granting || !grantPick"
                @click="addGrant"
              >
                {{ granting ? 'Granting…' : 'Grant' }}
              </AppButton>
            </div>
            <p v-if="grantOptions.length === 0 && selectedGrants.length > 0" class="manage__empty">
              All aircraft already granted.
            </p>
          </section>
        </div>
      </div>

      <p v-if="loading">Loading users…</p>
      <AppTable
        v-else
        :columns="columns"
        :rows="rows"
        row-key="id"
        empty-text="No users."
      >
        <template #cell-roles="{ value }">
          <span v-if="(value as Role[]).length === 0" class="admin-none">no roles</span>
          <span v-else class="admin-badges">
            <AppBadge
              v-for="r in value as Role[]"
              :key="r"
              :variant="roleVariant[r]"
            >{{ r }}</AppBadge>
          </span>
        </template>
        <template #cell-access="{ value }">
          {{ value === 0 ? '—' : `${value} aircraft` }}
        </template>
        <template #cell-actions="{ row }">
          <AppButton
            size="sm"
            variant="ghost"
            :data-test="`manage-${(row as any).id}`"
            @click="openManage((row as any)._user)"
          >
            Manage
          </AppButton>
        </template>
      </AppTable>
    </template>
  </AppShell>
</template>

<style scoped>
.manage {
  border: 1px solid var(--docs-border, #d0d9f3);
  background: var(--docs-bg-subtle, #f7f8fa);
  padding: 1rem;
  margin-bottom: 1.25rem;
}

.manage__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.manage__title {
  font-size: 16px;
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.manage__id {
  font-family: var(--font-mono);
  font-size: 11px;
  opacity: 0.6;
  font-weight: 400;
}

.manage__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
}

@media (max-width: 800px) {
  .manage__grid {
    grid-template-columns: 1fr;
  }
}

.manage__section {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin: 0 0 0.6rem 0;
  opacity: 0.75;
}

.manage__roles {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 0.85rem;
}

.manage__role-hint {
  margin: 0.1rem 0 0 1.6rem;
  font-size: 12px;
  opacity: 0.65;
}

.manage__grants {
  list-style: none;
  margin: 0 0 0.85rem 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.manage__grant {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border: 1px solid var(--docs-border, #d0d9f3);
  background: #fff;
  padding: 0.35rem 0.6rem;
  font-size: 13px;
}

.manage__add {
  display: flex;
  align-items: flex-end;
  gap: 0.6rem;
}

.manage__add > :first-child {
  flex: 1;
}

.manage__empty {
  font-size: 13px;
  opacity: 0.65;
  margin: 0 0 0.85rem 0;
}

.admin-badges {
  display: inline-flex;
  gap: 0.3rem;
  flex-wrap: wrap;
}

.admin-none {
  font-size: 12px;
  opacity: 0.6;
}
</style>
