<script setup lang="ts">
/**
 * AppButton — buttons in the Arrow docs industrial style: square corners,
 * mono allcaps labels, hard offset shadow (the admonition/code-block
 * 4px 4px 0 shadow) that the button "presses into" on :active.
 *
 * Variants:
 *  - primary: solid #0843BF (docs primary; matches docs CLA button)
 *  - secondary: white with blue border + blue text (docs pagination link)
 *  - ghost: borderless, text-only, tint on hover
 *  - danger: solid #dc2626 (docs danger admonition color)
 *
 * Renders <router-link> when `to` is set, <a> when `href` is set,
 * otherwise <button>.
 */
withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    size?: 'sm' | 'md';
    to?: string;
    href?: string;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    block?: boolean;
  }>(),
  { variant: 'primary', size: 'md', type: 'button' },
);
</script>

<template>
  <component
    :is="to ? 'router-link' : href ? 'a' : 'button'"
    :to="to || undefined"
    :href="href || undefined"
    :type="!to && !href ? type : undefined"
    :disabled="!to && !href ? disabled : undefined"
    class="btn"
    :class="[`btn--${variant}`, `btn--${size}`, { 'btn--block': block, 'is-disabled': disabled }]"
  >
    <slot name="icon" />
    <slot />
  </component>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  font-family: var(--font-mono);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  border-radius: var(--radius);
  border: 1px solid transparent;
  cursor: pointer;
  text-decoration: none !important;
  white-space: nowrap;
  user-select: none;
  transition: background-color 0.15s ease, border-color 0.15s ease,
    color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}

.btn--md {
  font-size: 12px;
  padding: 0.55rem 1.1rem;
}

.btn--sm {
  font-size: 11px;
  padding: 0.35rem 0.75rem;
}

.btn--block {
  display: flex;
  width: 100%;
}

/* --- primary: solid docs blue, hard shadow, presses in on click --- */
.btn--primary {
  background: var(--docs-primary);
  border-color: var(--docs-primary-darker);
  color: #ffffff;
  box-shadow: var(--shadow-hard-strong);
}

.btn--primary:hover {
  background: var(--docs-primary-dark);
  color: #ffffff;
}

.btn--primary:active {
  transform: translate(2px, 2px);
  box-shadow: 1px 1px 0 0 rgba(0, 0, 0, 0.12);
}

/* --- secondary: bordered blue on white (docs pagination link) --- */
.btn--secondary {
  background: var(--docs-bg);
  border-color: var(--docs-primary);
  color: var(--docs-primary);
  box-shadow: var(--shadow-hard);
}

.btn--secondary:hover {
  background: rgba(8, 67, 191, 0.05);
  color: var(--docs-primary);
}

.btn--secondary:active {
  transform: translate(2px, 2px);
  box-shadow: 1px 1px 0 0 rgba(0, 0, 0, 0.05);
}

/* --- ghost: quiet text button --- */
.btn--ghost {
  background: transparent;
  border-color: transparent;
  color: var(--docs-text-secondary);
}

.btn--ghost:hover {
  background: var(--docs-bg-subtle);
  color: var(--docs-text);
}

.btn--ghost:active {
  background: var(--code-bg);
}

/* --- danger --- */
.btn--danger {
  background: var(--status-danger);
  border-color: #b91c1c;
  color: #ffffff;
  box-shadow: var(--shadow-hard-strong);
}

.btn--danger:hover {
  background: #b91c1c;
  color: #ffffff;
}

.btn--danger:active {
  transform: translate(2px, 2px);
  box-shadow: 1px 1px 0 0 rgba(0, 0, 0, 0.12);
}

/* --- shared states --- */
.btn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.btn:disabled,
.btn.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
  pointer-events: none;
  box-shadow: none;
  transform: none;
}

.btn :deep(svg) {
  width: 1em;
  height: 1em;
  flex-shrink: 0;
}
</style>
