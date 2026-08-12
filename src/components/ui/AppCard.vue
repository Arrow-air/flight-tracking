<script setup lang="ts">
/**
 * AppCard — port of the Arrow docs card component (.cards / .card):
 * square-cornered card on #f1f3f8 with the #b1c0ec border, a bayer-dither
 * pattern rising from the bottom edge, blue title with an arrow that
 * pulses on hover, and the signature hover lift (translateY(-4px) +
 * border/bg shift, dither saturates to blue).
 *
 * Renders as a <router-link> when `to` is set (hover behavior enabled),
 * otherwise as a static <div>.
 *
 * Slots: default (body), title (overrides `title` prop), meta (footer row).
 */
withDefaults(
  defineProps<{
    title?: string;
    to?: string;
    /** show the hover arrow next to the title (link cards) */
    arrow?: boolean;
  }>(),
  { arrow: true },
);
</script>

<template>
  <component
    :is="to ? 'router-link' : 'div'"
    :to="to"
    class="card"
    :class="{ 'card--link': !!to }"
  >
    <div class="card__content">
      <div v-if="title || $slots.title" class="card__title">
        <slot name="title">{{ title }}</slot>
        <span v-if="to && arrow" class="card__title-arrow" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
            <path
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="square"
              d="M4 12h15M13 6l6 6-6 6"
            />
          </svg>
        </span>
      </div>
      <div v-if="$slots.default" class="card__body">
        <slot />
      </div>
      <div v-if="$slots.meta" class="card__meta">
        <slot name="meta" />
      </div>
    </div>
  </component>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  text-decoration: none !important;
  border-radius: 0;
  border: 1px solid var(--card-border);
  /* C1: plain light background — the tinted --card-bg + dither made body
     text hard to read; hover still shifts to the tinted hover color. */
  background: var(--docs-bg, #ffffff);
  position: relative;
  isolation: isolate;
  box-shadow: none;
  overflow: visible;
  will-change: transform;
  transition: transform 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94),
    box-shadow 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94),
    background-color 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94),
    border-color 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

/* Bayer dither pattern rising from the bottom edge */
.card::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background-image: url('./card-bayer-gradient.svg');
  background-repeat: repeat-x;
  background-position: left bottom;
  background-size: 8px 130px;
  /* C1: keep the signature dither but far fainter at rest */
  filter: saturate(0) opacity(0.06);
  transition: filter 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

/* P6 (v2.2): the hover state used to jump the dither to FULL opacity —
   saturated blue pixels rising under the body/meta text made tiles
   unreadable exactly while hovering (the C1 at-rest fix above stays at
   0.06). Keep the color returning as part of the affordance, but capped
   low; the lift/border/background shift below carry the rest. */
.card--link:hover::before {
  filter: saturate(1) opacity(0.14);
}

.card--link:hover {
  background: var(--card-hover-color);
  border-color: var(--card-hover-border);
  transform: translateY(-4px);
  box-shadow: var(--shadow-lift);
}

.card--link:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.card__content {
  padding: 1rem 1.25rem;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.card__title {
  font-family: var(--font-sans);
  font-size: 1.125rem;
  font-weight: 500;
  color: var(--docs-text); /* static cards: dark title (docs) */
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.card--link .card__title {
  color: var(--docs-primary); /* link cards: blue title (docs) */
}

.card__title-arrow {
  margin-left: auto;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  color: var(--docs-primary);
  opacity: 0.6;
  transition: opacity 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

@keyframes card-arrow-pulse {
  0% {
    transform: translateX(0);
  }
  40% {
    transform: translateX(5px);
  }
  100% {
    transform: translateX(0);
  }
}

.card--link:hover .card__title-arrow {
  opacity: 0.9;
  animation: card-arrow-pulse 0.4s ease-out forwards;
}

.card__body {
  padding: 0.2rem 0 0.5rem 0;
  font-size: 14px;
  /* C1: darker body copy (was #6a7c95 — low contrast on the dither) */
  color: #3d5270;
  line-height: 1.55;
  transition: color 0.15s ease;
}

.card__body :deep(p) {
  margin: 0;
  font-size: 14px;
  line-height: 1.55;
}

.card--link:hover .card__body {
  color: var(--docs-text, #1f2a3d);
}

.card__meta {
  margin-top: auto;
  padding-top: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--font-mono-display);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--docs-text-muted);
  transition: color 0.15s ease;
}

/* P6: meta row darkens on hover like the body does — 10px muted text on
   the tinted hover background + dither was the least readable element. */
.card--link:hover .card__meta {
  color: var(--docs-text-secondary, #4b5563);
}
</style>
