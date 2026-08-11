<script setup lang="ts">
/**
 * AppSidebar — port of the Arrow docs left sidebar: sticky bordered column
 * below the navbar, top-level section labels in allcaps mono with a 6-dot
 * grid icon, nested links in Neue Haas with a page icon, blue active state
 * with a right accent border, and the pixel-slash strip at the bottom.
 */
import { useRoute } from 'vue-router';

export interface SidebarLink {
  label: string;
  to: string;
  /** mark active manually (otherwise matched against current route) */
  active?: boolean;
}

export interface SidebarSection {
  label: string;
  /** optional route for the section label itself */
  to?: string;
  items: SidebarLink[];
}

const props = defineProps<{
  sections: SidebarSection[];
  /** bottom strip label, e.g. app version */
  footerLabel?: string;
}>();

const route = useRoute();

function isActive(item: SidebarLink): boolean {
  if (item.active !== undefined) return item.active;
  return route.path === item.to;
}

function sectionActive(section: SidebarSection): boolean {
  return section.items.some((i) => isActive(i));
}
</script>

<template>
  <aside class="sidebar">
    <nav class="sidebar__nav thin-scroll">
      <div
        v-for="section in props.sections"
        :key="section.label"
        class="sidebar__section"
      >
        <component
          :is="section.to ? 'router-link' : 'div'"
          :to="section.to"
          class="sidebar__section-label"
          :class="{ 'is-active': sectionActive(section) }"
        >
          <!-- 6-dot grid icon (docs top-level marker) -->
          <svg
            class="sidebar__section-icon"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <path
              fill="currentColor"
              d="M6 5a1 1 0 1 0 0-2a1 1 0 0 0 0 2m0 4a1 1 0 1 0 0-2a1 1 0 0 0 0 2m1 3a1 1 0 1 1-2 0a1 1 0 0 1 2 0m3-7a1 1 0 1 0 0-2a1 1 0 0 0 0 2m1 3a1 1 0 1 1-2 0a1 1 0 0 1 2 0m-1 5a1 1 0 1 0 0-2a1 1 0 0 0 0 2"
            />
          </svg>
          {{ section.label }}
        </component>

        <ul class="sidebar__list">
          <li v-for="item in section.items" :key="item.to">
            <router-link
              class="sidebar__link"
              :class="{ 'is-active': isActive(item) }"
              :to="item.to"
            >
              <!-- page icon (docs level-2 link marker) -->
              <svg
                class="sidebar__link-icon"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <g fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M8 18H16" stroke-miterlimit="10" stroke-linecap="square" />
                  <path d="M8 14L11 14" stroke-miterlimit="10" stroke-linecap="square" />
                  <path d="M12 2V10H4" />
                  <path d="M20 22V2H10.5919L4 8.58984V22H20Z" />
                </g>
              </svg>
              {{ item.label }}
            </router-link>
          </li>
        </ul>
      </div>
    </nav>

    <div class="sidebar__footer">
      <span v-if="props.footerLabel" class="sidebar__footer-label">
        &gt; {{ props.footerLabel }}
      </span>
    </div>
    <div class="sidebar__strip" />
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-width);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  position: sticky;
  top: var(--navbar-height);
  align-self: flex-start;
  min-height: calc(100vh - var(--navbar-height) - 32px);
  max-height: calc(100vh - var(--navbar-height) - 32px);
  border-right: 1px solid #d1d5db;
  padding-top: 1rem;
  background: var(--docs-bg);
}

.sidebar__nav {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 0.5rem 1rem 0;
}

.sidebar__section + .sidebar__section {
  margin-top: 0.25rem;
}

/* Top-level label — allcaps mono, black, 6-dot icon */
.sidebar__section-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--font-mono-label);
  font-size: 14px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #000000;
  text-decoration: none;
  padding: 0.5rem 0.75rem 0.5rem 0.5rem;
  border-radius: 4px 0 0 4px;
  transition: background 0.03s ease, color 0.03s ease;
}

a.sidebar__section-label:hover {
  background: rgba(8, 67, 191, 0.04);
  text-decoration: none;
  color: #000000;
}

.sidebar__section-label.is-active {
  color: var(--docs-primary);
}

.sidebar__section-icon {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}

.sidebar__list {
  list-style: none;
  margin: 0.125rem 0 0.375rem 0;
  padding: 0;
}

/* Nested link — Neue Haas 14px, page icon, blue active w/ right border */
.sidebar__link {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 400;
  color: var(--docs-text-secondary);
  text-decoration: none;
  padding: 0.3rem 0.75rem 0.3rem 1.1rem;
  margin-top: 0.125rem;
  border-radius: 4px 0 0 4px;
  border-right: 1px solid transparent;
  transition: color 0.03s ease, background-color 0.03s ease;
}

.sidebar__link-icon {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  opacity: 0.5;
  transition: opacity 0.15s ease;
}

.sidebar__link:hover {
  color: var(--docs-text);
  background: var(--docs-bg-subtle);
  border-right-color: #bfc3c8;
  text-decoration: none;
}

.sidebar__link:hover .sidebar__link-icon {
  opacity: 0.8;
}

.sidebar__link.is-active {
  color: var(--docs-primary);
  background: var(--docs-primary-light);
  font-weight: 500;
  border-right-color: var(--docs-primary);
}

.sidebar__link.is-active .sidebar__link-icon {
  opacity: 1;
}

.sidebar__link.is-active:hover {
  color: #052d80;
}

.sidebar__link:focus-visible,
.sidebar__section-label:focus-visible {
  outline: none;
  box-shadow: inset var(--focus-ring);
}

/* Bottom label chip (docs "powered by" bar) */
.sidebar__footer {
  flex-shrink: 0;
  position: relative;
  padding: 0.5rem 1rem 0.5rem 0;
}

/* scroll fade above the footer */
.sidebar__footer::before {
  content: '';
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  height: 64px;
  background: linear-gradient(to bottom, transparent, var(--docs-bg));
  pointer-events: none;
}

.sidebar__footer:empty {
  display: none;
}

.sidebar__footer-label {
  display: block;
  font-family: var(--font-mono-display);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #ffffff;
  background: var(--docs-primary);
  border: 1px solid var(--brand-navy);
  padding: 0.45rem 0.75rem;
}

/* Pixel-art diagonal strip at the very bottom */
.sidebar__strip {
  flex-shrink: 0;
  height: 12px;
  background-image: var(--pixel-slash-grey);
  background-repeat: repeat-x;
  background-size: 6px 8px;
  background-position: 0 center;
  image-rendering: pixelated;
}

@media (max-width: 996px) {
  .sidebar {
    display: none;
  }
}
</style>
