<script setup lang="ts">
/**
 * AppBreadcrumbs — port of the docs breadcrumbs: tiny Departure Mono
 * allcaps trail, muted grey links that darken on hover, active (last)
 * item on the #eef0f3 chip background.
 */
export interface Crumb {
  label: string;
  to?: string;
}

defineProps<{ items: Crumb[] }>();
</script>

<template>
  <nav class="breadcrumbs" aria-label="Breadcrumbs">
    <ol class="breadcrumbs__list">
      <li
        v-for="(item, i) in items"
        :key="`${item.label}-${i}`"
        class="breadcrumbs__item"
        :class="{ 'is-active': i === items.length - 1 }"
      >
        <router-link
          v-if="item.to && i !== items.length - 1"
          class="breadcrumbs__link"
          :to="item.to"
        >
          {{ item.label }}
        </router-link>
        <span v-else class="breadcrumbs__link" aria-current="page">
          {{ item.label }}
        </span>
        <span
          v-if="i !== items.length - 1"
          class="breadcrumbs__sep"
          aria-hidden="true"
          >/</span
        >
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.breadcrumbs {
  font-family: var(--font-mono-display);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 0.5rem;
}

.breadcrumbs__list {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.breadcrumbs__item {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.breadcrumbs__link {
  font-size: 0.7rem;
  line-height: 1;
  color: var(--docs-text-muted);
  text-decoration: none;
  padding: 0.25rem 0.5rem;
  transition: color 0.15s ease;
}

.breadcrumbs__item:first-child a.breadcrumbs__link {
  padding-left: 0;
}

a.breadcrumbs__link:hover {
  color: var(--docs-text);
  background: none;
  text-decoration: none;
}

a.breadcrumbs__link:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.breadcrumbs__item.is-active .breadcrumbs__link {
  color: var(--docs-text);
  background: #eef0f3;
}

.breadcrumbs__sep {
  font-size: 0.7rem;
  color: var(--docs-text-muted);
  opacity: 0.5;
}
</style>
