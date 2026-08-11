<script setup lang="ts">
/**
 * AlertBanner — inline status strip in the docs admonition style.
 * Used to surface EVERY write error loudly (v1 pain point #1: no silent
 * failures) and success confirmations.
 */
withDefaults(
  defineProps<{
    kind?: 'error' | 'success' | 'info' | 'warning';
    /** message text; slot overrides */
    message?: string;
  }>(),
  { kind: 'info' },
);
</script>

<template>
  <div class="alert" :class="`alert--${kind}`" role="alert">
    <span class="alert__label">
      {{ kind === 'error' ? 'Error' : kind === 'success' ? 'OK' : kind === 'warning' ? 'Warning' : 'Note' }}
    </span>
    <span class="alert__body"><slot>{{ message }}</slot></span>
  </div>
</template>

<style scoped>
.alert {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  border: 1px solid;
  padding: 0.6rem 0.85rem;
  margin: 0 0 1rem 0;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.45;
  background: var(--docs-bg);
}

.alert__label {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  flex-shrink: 0;
}

.alert__body {
  min-width: 0;
  overflow-wrap: anywhere;
}

.alert--error {
  border-color: #dc2626;
  background: rgba(220, 38, 38, 0.06);
}
.alert--error .alert__label {
  color: #dc2626;
}

.alert--success {
  border-color: #16a34a;
  background: rgba(22, 163, 74, 0.06);
}
.alert--success .alert__label {
  color: #16a34a;
}

.alert--warning {
  border-color: #d97706;
  background: rgba(217, 119, 6, 0.07);
}
.alert--warning .alert__label {
  color: #b45309;
}

.alert--info {
  border-color: var(--docs-border, #d0d9f3);
  background: var(--docs-primary-light, rgba(8, 67, 191, 0.08));
}
.alert--info .alert__label {
  color: var(--docs-primary);
}
</style>
