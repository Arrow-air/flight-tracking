<script setup lang="ts">
/**
 * AppNavbar — port of the Arrow docs 72px top navbar
 * (website/src/theme/Navbar/DocsNavbar.module.css): #0943bf bar with a
 * pixel-slash strip along the bottom edge, white Arrow wordmark with a
 * mono divider label, and bordered icon/action buttons on the right.
 *
 * Slots:
 *  - actions: right-hand side controls (use .navbar-action / AppButton)
 *  - default: extra items next to the brand (e.g. environment chip)
 */
withDefaults(
  defineProps<{
    /** Small allcaps label after the wordmark divider */
    label?: string;
    /** Router target for the brand link */
    to?: string;
  }>(),
  { label: 'Flight Tracking', to: '/' },
);
</script>

<template>
  <header class="navbar">
    <div class="navbar__inner">
      <router-link class="navbar__brand" :to="to">
        <!-- Arrow wordmark (website/static/img/brand/wordmark_white.svg) -->
        <svg
          class="navbar__wordmark"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 657.38 193.42"
          aria-label="Arrow"
          role="img"
        >
          <path fill="#ffffff" d="M162.9,120.1l-50.36-11.17-31.09,84.49-31.09-84.49L0,120.1,81.45,0l81.45,120.1Z"/>
          <path fill="#ffffff" d="M183.1,151.64l41.23-106.46,25.25-3.68,43.27,110.14h-28.72l-6.99-20.98-39.39,1.87-6.37,19.12h-28.28ZM225.07,110.59l24.96-1.57-12.27-36.4-12.69,37.97h0Z"/>
          <path fill="#ffffff" d="M359.06,68.72v28.28c-1.78-.65-3.68-1.1-5.69-1.3-.83-.09-1.69-.12-2.58-.12-6.08,0-11.29,2.05-15,5.57-3.79,3.59-7.23,8.68-7.23,14.73v35.8h-25.46v-81.36l25.04-3.97v12.03c7.29-6.19,16.51-9.9,26.56-9.9,1.48,0,2.93.09,4.36.24Z"/>
          <path fill="#ffffff" d="M426.37,68.72v28.28c-1.78-.65-3.68-1.1-5.69-1.3-.83-.09-1.69-.12-2.58-.12-6.08,0-11.29,2.05-15,5.57-3.79,3.59-7.23,8.68-7.23,14.73v35.8h-25.46v-81.36l25.04-3.97v12.03c7.29-6.19,16.51-9.9,26.56-9.9,1.48,0,2.93.09,4.36.24Z"/>
          <path fill="#ffffff" d="M578.54,81.37l19.21-2.52,12.51,35.6,14.46-47.16,32.66-4.53-32.31,89.15h-22.58l-14.23-37.11-10.97,36.78h-22.35l-28.31-79.85,29.05-3.82,11.91,45.97,11-32.54h-.06v.03h0Z"/>
          <path fill="#ffffff" d="M479.22,151.64c-25.05,0-45.34-19.09-45.34-42.65s20.29-42.65,45.34-42.65,45.34,19.09,45.34,42.65-19.99,42.65-45.34,42.65ZM479.22,129.28c11.64,0,19.69-8.35,19.69-20.29s-8.05-20.29-19.69-20.29-19.69,8.65-19.69,20.29,8.35,20.29,19.69,20.29h0Z"/>
        </svg>
        <span v-if="label" class="navbar__label">{{ label }}</span>
      </router-link>

      <slot />

      <nav class="navbar__actions">
        <slot name="actions" />
      </nav>
    </div>
  </header>
</template>

<style scoped>
.navbar {
  position: sticky;
  top: 0;
  z-index: 400;
  background: var(--navbar-bg);
  height: var(--navbar-height);
  display: flex;
  align-items: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
}

/* Pixel slash strip along the bottom edge */
.navbar::after {
  content: '';
  position: absolute;
  bottom: 4px;
  left: 0;
  right: 0;
  height: 8px;
  background-image: var(--pixel-slash-light);
  background-repeat: repeat-x;
  background-size: 6px 8px;
  image-rendering: pixelated;
  pointer-events: none;
}

.navbar__inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  max-width: var(--page-max-width);
  margin: 0 auto;
  padding: 0 1.5rem 12px;
}

.navbar__brand {
  display: flex;
  align-items: center;
  color: #ffffff;
  text-decoration: none;
  transition: opacity 0.15s ease;
}

.navbar__brand:hover {
  opacity: 0.8;
  color: #ffffff;
  text-decoration: none;
}

.navbar__wordmark {
  width: 108px;
  height: 32px;
  display: block;
}

.navbar__label {
  margin-left: 12px;
  padding-left: 12px;
  border-left: 1px solid rgba(255, 255, 255, 0.2);
  font-family: var(--font-mono-display);
  font-size: 0.7rem;
  font-weight: 400;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.45);
  white-space: nowrap;
  line-height: 1;
  position: relative;
  top: 4px;
}

.navbar__actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-left: 0.75rem;
}

/* Bordered navbar control — apply to <a>/<button>/<router-link> in the
   actions slot. Matches the docs .iconButton style. */
.navbar__actions :deep(.navbar-action) {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 36px;
  min-width: 36px;
  padding: 0 10px;
  color: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: var(--radius-soft);
  background: transparent;
  text-decoration: none;
  cursor: pointer;
  font-family: var(--font-mono-display);
  font-size: 0.65rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
  transition: color 0.15s ease, border-color 0.15s ease,
    background 0.15s ease;
}

.navbar__actions :deep(.navbar-action:hover) {
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.5);
  background: rgba(0, 0, 0, 0.14);
  text-decoration: none;
}

.navbar__actions :deep(.navbar-action:focus-visible) {
  outline: none;
  border-color: rgba(255, 255, 255, 0.7);
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.25);
}

.navbar__actions :deep(.navbar-action.is-active) {
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.6);
  background: rgba(0, 0, 0, 0.2);
}

@media (max-width: 576px) {
  .navbar__inner {
    padding: 0 0.75rem 12px;
  }
  .navbar__wordmark {
    width: 90px;
  }
  .navbar__label {
    display: none;
  }
}
</style>
