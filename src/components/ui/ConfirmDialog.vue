<script setup lang="ts">
/**
 * ConfirmDialog — destructive-action confirmation in the Arrow docs style
 * (square corners, hard shadow, danger accent). P3 (v2.2).
 *
 * Two strengths:
 *  - plain confirm (flight delete): Cancel / danger-confirm buttons.
 *  - type-to-confirm (aircraft delete, which cascades operator grants and
 *    history): set `requireText` and the confirm button stays disabled until
 *    the user types it verbatim.
 *
 * Parent controls visibility (v-if); emits `confirm` / `cancel`. Escape and
 * backdrop click cancel; the input (or the dialog) is focused on mount.
 */
import { onMounted, onUnmounted, ref } from 'vue';
import AppButton from './AppButton.vue';
import AppInput from './AppInput.vue';

const props = withDefaults(
  defineProps<{
    title: string;
    confirmLabel?: string;
    /** Type-to-confirm challenge (e.g. the aircraft serial). */
    requireText?: string;
    busy?: boolean;
  }>(),
  { confirmLabel: 'Delete' },
);

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const typed = ref('');
const rootEl = ref<HTMLElement | null>(null);

function confirmArmed(): boolean {
  return !props.requireText || typed.value.trim() === props.requireText;
}

function onConfirm() {
  if (confirmArmed() && !props.busy) emit('confirm');
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('cancel');
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  // Focus the challenge input if present, else the dialog itself.
  requestAnimationFrame(() => {
    const input = rootEl.value?.querySelector<HTMLInputElement>('input');
    (input ?? rootEl.value)?.focus();
  });
});
onUnmounted(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="cdlg__backdrop" data-test="confirm-dialog" @click.self="emit('cancel')">
    <div
      ref="rootEl"
      class="cdlg"
      role="alertdialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
    >
      <h3 class="cdlg__title">{{ title }}</h3>
      <div class="cdlg__body">
        <slot />
      </div>
      <form v-if="requireText" class="cdlg__challenge" @submit.prevent="onConfirm">
        <AppInput
          v-model="typed"
          :label="`Type ${requireText} to confirm`"
          :placeholder="requireText"
          mono
          data-test="confirm-challenge"
        />
      </form>
      <div class="cdlg__actions">
        <AppButton size="sm" variant="ghost" :disabled="busy" @click="emit('cancel')">
          Cancel
        </AppButton>
        <AppButton
          size="sm"
          variant="danger"
          :disabled="busy || !confirmArmed()"
          data-test="confirm-delete"
          @click="onConfirm"
        >
          {{ busy ? 'Deleting…' : confirmLabel }}
        </AppButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cdlg__backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12vh 1rem 1rem;
}

.cdlg {
  background: var(--docs-bg, #ffffff);
  border: 1px solid var(--status-danger, #dc2626);
  border-top: 3px solid var(--status-danger, #dc2626);
  box-shadow: var(--shadow-hard-strong, 4px 4px 0 0 rgba(0, 0, 0, 0.12));
  width: min(480px, 100%);
  padding: 1.25rem 1.5rem;
  outline: none;
}

.cdlg__title {
  margin: 0 0 0.6rem;
  font-size: 16px;
}

.cdlg__body {
  font-size: 14px;
  color: var(--docs-text-secondary, #3d5270);
}

.cdlg__body :deep(p) {
  margin: 0 0 0.6rem;
}

.cdlg__challenge {
  margin-top: 0.9rem;
}

.cdlg__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1.1rem;
}
</style>
