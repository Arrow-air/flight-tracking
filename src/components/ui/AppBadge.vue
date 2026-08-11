<script setup lang="ts">
/**
 * AppBadge — status pills from the docs voting-history table (.pill):
 * rounded tinted chips, plus a `square` mono variant for technical
 * status labels (upload/parse pipeline states).
 *
 * `status` maps flight-log pipeline states to variants for convenience:
 *   uploaded → info, parsing → warning, parsed → success, error → danger.
 */
import { computed } from 'vue';

type Variant = 'success' | 'danger' | 'warning' | 'info' | 'neutral' | 'primary';

const props = withDefaults(
  defineProps<{
    variant?: Variant;
    /** flight-log status shorthand; overrides variant */
    status?: 'uploaded' | 'parsing' | 'parsed' | 'error';
    /** square mono style instead of rounded pill */
    square?: boolean;
    /** leading status dot */
    dot?: boolean;
  }>(),
  { variant: 'neutral' },
);

const statusMap: Record<string, Variant> = {
  uploaded: 'info',
  parsing: 'warning',
  parsed: 'success',
  error: 'danger',
};

const resolved = computed<Variant>(() =>
  props.status ? statusMap[props.status] : props.variant,
);
</script>

<template>
  <span
    class="badge"
    :class="[`badge--${resolved}`, { 'badge--square': square }]"
  >
    <span v-if="dot" class="badge__dot" aria-hidden="true" />
    <slot>{{ status }}</slot>
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  padding: 2px 8px;
  border-radius: 999px;
  font-family: var(--font-sans);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
  line-height: 1.5;
}

.badge--square {
  border-radius: 0;
  font-family: var(--font-mono-display);
  font-weight: 500;
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 3px 8px;
  border: 1px solid currentColor;
}

.badge__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.badge--square .badge__dot {
  border-radius: 0;
}

/* tints from docs .pill--* + admonition palette */
.badge--success {
  background-color: var(--status-success-tint);
  color: var(--status-success-text);
}

.badge--danger {
  background-color: var(--status-danger-tint);
  color: var(--status-danger-text);
}

.badge--warning {
  background-color: var(--status-warning-tint);
  color: var(--status-warning-text);
}

.badge--info {
  background-color: rgba(37, 99, 235, 0.12);
  color: #1d4ed8;
}

.badge--neutral {
  background-color: rgba(107, 114, 128, 0.12);
  color: var(--docs-text-secondary);
}

.badge--primary {
  background-color: var(--docs-primary-light);
  color: var(--docs-primary);
}
</style>
