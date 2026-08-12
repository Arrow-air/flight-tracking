<script setup lang="ts">
/**
 * AppShell — the authenticated chrome: docs navbar (user + sign out),
 * role-aware sidebar, breadcrumbs, content column.
 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import AppNavbar from './ui/AppNavbar.vue';
import AppSidebar from './ui/AppSidebar.vue';
import type { SidebarSection } from './ui/AppSidebar.vue';
import AppBreadcrumbs from './ui/AppBreadcrumbs.vue';
import type { Crumb } from './ui/AppBreadcrumbs.vue';
import { auth, isAdmin, isManufacturer, roles, signOut, userEmail } from '../lib/auth';

const props = withDefaults(
  defineProps<{
    crumbs?: Crumb[];
    /** widen the content column (tables/uploads) */
    wide?: boolean;
  }>(),
  { wide: true },
);

const router = useRouter();

const sections = computed<SidebarSection[]>(() => {
  const fleet: SidebarSection = {
    label: 'Fleet',
    items: [
      { label: 'Aircraft', to: '/' },
      { label: 'Sites', to: '/sites' },
    ],
  };
  const flights: SidebarSection = {
    label: 'Flights',
    items: [
      { label: 'All flights', to: '/flights' },
      { label: 'Quick log', to: '/flights/new' },
      { label: 'Bulk upload', to: '/upload' },
      { label: 'Log status', to: '/logs' },
    ],
  };
  const out = [fleet, flights];
  if (isManufacturer.value || isAdmin.value) {
    out.push({
      label: 'Manufacturing',
      items: [{ label: 'New aircraft', to: '/aircraft/new' }],
    });
  }
  if (isAdmin.value) {
    out.push({
      label: 'Admin',
      items: [{ label: 'Users & access', to: '/admin' }],
    });
  }
  return out;
});

const roleLabel = computed(() =>
  roles.value.length ? roles.value.join(' · ').toUpperCase() : 'NO ROLE',
);

async function onSignOut() {
  await signOut();
  router.push('/login');
}
</script>

<template>
  <div class="app-shell">
    <AppNavbar label="Flight Tracking">
      <template #actions>
        <!-- P4: the user block links to /profile (name, roles, copyable id) -->
        <router-link
          v-if="auth.profile"
          class="shell-user"
          to="/profile"
          title="Your profile — name, roles and your user id"
          data-test="profile-link"
        >
          <span class="shell-user__name">{{ auth.profile.name ?? userEmail }}</span>
          <span class="shell-user__role">{{ roleLabel }}</span>
        </router-link>
        <a class="navbar-action" href="#" data-test="sign-out" @click.prevent="onSignOut">
          Sign out
        </a>
      </template>
    </AppNavbar>

    <div class="app-body">
      <AppSidebar :sections="sections" footer-label="Flight Tracking v2" />

      <main class="app-main">
        <div class="app-content" :class="{ 'app-content--wide': props.wide }">
          <AppBreadcrumbs v-if="props.crumbs?.length" :items="props.crumbs" />
          <slot />
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell-user {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  margin-right: 0.5rem;
  color: #ffffff;
  text-decoration: none;
}

.shell-user:hover {
  color: #ffffff;
  text-decoration: none;
}

.shell-user:hover .shell-user__name {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.shell-user__name {
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.2;
}

.shell-user__role {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.1em;
  opacity: 0.75;
}
</style>
