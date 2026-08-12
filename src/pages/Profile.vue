<script setup lang="ts">
/**
 * /profile — P4 (v2.2): the signed-in user's own account card. Exists so
 * anyone can find and COPY their user id (uuid) — e.g. to hand to an admin
 * for an operator assignment — plus name, email and roles at a glance.
 *
 * Email comes from the GoTrue session (auth.users is not client-readable;
 * user_profiles carries no email by design). Everything else is the
 * already-loaded auth store — no extra queries.
 */
import { computed, onUnmounted, ref } from 'vue';
import AppShell from '../components/AppShell.vue';
import AppBadge from '../components/ui/AppBadge.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppCard from '../components/ui/AppCard.vue';
import { auth, roles, userEmail, userId } from '../lib/auth';

const displayName = computed(
  () => auth.profile?.name ?? userEmail.value ?? 'Your profile',
);

// --- copy user id ------------------------------------------------------------
const copied = ref(false);
const copyError = ref('');
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copyUserId() {
  const id = userId.value;
  if (!id) return;
  copyError.value = '';
  try {
    await navigator.clipboard.writeText(id);
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied.value = false), 2000);
  } catch {
    // Clipboard API can be unavailable (permissions/insecure context) —
    // the id is selectable text right next to the button.
    copyError.value = 'Clipboard unavailable — select the id and copy it manually.';
  }
}

onUnmounted(() => {
  if (copyTimer) clearTimeout(copyTimer);
});
</script>

<template>
  <AppShell :crumbs="[{ label: 'Profile' }]" :wide="false">
    <div class="page-header">
      <h1>{{ displayName }}</h1>
      <p class="page-header__description">
        Your account. Share your user id with an admin to get roles or
        aircraft operator assignments.
      </p>
    </div>

    <AppCard title="Account">
      <dl class="profile__list">
        <dt>Name</dt>
        <dd data-test="profile-name">{{ auth.profile?.name ?? '—' }}</dd>

        <dt>Email</dt>
        <dd data-test="profile-email">{{ userEmail ?? '—' }}</dd>

        <dt>Roles</dt>
        <dd data-test="profile-roles">
          <template v-if="roles.length">
            <AppBadge v-for="r in roles" :key="r" variant="primary" square>
              {{ r }}
            </AppBadge>
          </template>
          <span v-else class="profile__muted">
            no role assigned yet — ask an admin
          </span>
        </dd>

        <dt>User id</dt>
        <dd class="profile__id-row">
          <code class="profile__id" data-test="profile-user-id">{{ userId ?? '—' }}</code>
          <AppButton
            v-if="userId"
            size="sm"
            variant="secondary"
            data-test="copy-user-id"
            @click="copyUserId"
          >
            {{ copied ? 'Copied ✓' : 'Copy' }}
          </AppButton>
        </dd>
      </dl>
      <p v-if="copyError" class="profile__copy-error" data-test="copy-error">
        {{ copyError }}
      </p>
      <template #meta>
        <span class="mono-label">Operator of {{ auth.operatorOf.length }} aircraft</span>
      </template>
    </AppCard>
  </AppShell>
</template>

<style scoped>
.profile__list {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.55rem 1.25rem;
  margin: 0;
  font-size: 14px;
}

.profile__list dt {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--docs-text-muted);
  align-self: baseline;
}

.profile__list dd {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.profile__id-row {
  gap: 0.75rem;
}

.profile__id {
  font-family: var(--font-mono);
  font-size: 13px;
  background: var(--docs-bg-subtle, #f3f6f9);
  border: 1px solid var(--docs-border, #e5e7eb);
  padding: 0.25rem 0.5rem;
  user-select: all;
  word-break: break-all;
}

.profile__muted {
  color: var(--docs-text-muted);
}

.profile__copy-error {
  margin: 0.6rem 0 0;
  font-size: 13px;
  color: #b91c1c;
}
</style>
