<script setup lang="ts">
/**
 * AppInput — form controls in the docs style: mono allcaps field labels
 * (docs h5 treatment), square-cornered bordered inputs on white, blue
 * focus border + soft ring, mono text for technical values.
 *
 * `as` selects the control: 'input' (default), 'textarea', 'select',
 * 'checkbox'. For selects pass `options` or use the default slot for
 * <option> elements.
 */
import { computed, useId } from 'vue';

export interface SelectOption {
  label: string;
  value: string | number;
}

const props = withDefaults(
  defineProps<{
    as?: 'input' | 'textarea' | 'select' | 'checkbox';
    label?: string;
    type?: string;
    placeholder?: string;
    hint?: string;
    error?: string;
    required?: boolean;
    disabled?: boolean;
    /** render the value in mono (tail numbers, coords, checksums) */
    mono?: boolean;
    options?: SelectOption[];
    rows?: number;
    id?: string;
  }>(),
  { as: 'input', type: 'text', rows: 4 },
);

const model = defineModel<string | number | boolean>();

/** typed views over the model so template bindings typecheck */
const textModel = computed<string | number | undefined>({
  get: () => (typeof model.value === 'boolean' ? undefined : model.value),
  set: (v) => (model.value = v),
});

const boolModel = computed<boolean>({
  get: () => model.value === true,
  set: (v) => (model.value = v),
});

const uid = useId();
const fieldId = computed(() => props.id ?? `field-${uid}`);
</script>

<template>
  <div
    class="field"
    :class="{ 'field--error': !!error, 'field--disabled': disabled }"
  >
    <!-- checkbox layout: box first, label after -->
    <label v-if="as === 'checkbox'" class="field__check" :for="fieldId">
      <input
        :id="fieldId"
        type="checkbox"
        class="field__checkbox"
        :disabled="disabled"
        v-model="boolModel"
      />
      <span class="field__check-label">
        {{ label }}<span v-if="required" class="field__required">*</span>
      </span>
    </label>

    <template v-else>
      <label v-if="label" class="field__label" :for="fieldId">
        {{ label }}<span v-if="required" class="field__required">*</span>
      </label>

      <textarea
        v-if="as === 'textarea'"
        :id="fieldId"
        class="field__control field__control--textarea"
        :class="{ 'field__control--mono': mono }"
        :placeholder="placeholder"
        :rows="rows"
        :disabled="disabled"
        :required="required"
        v-model="textModel"
      />

      <div v-else-if="as === 'select'" class="field__select-wrap">
        <select
          :id="fieldId"
          class="field__control field__control--select"
          :class="{ 'field__control--mono': mono }"
          :disabled="disabled"
          :required="required"
          v-model="textModel"
        >
          <slot>
            <option
              v-for="opt in options ?? []"
              :key="String(opt.value)"
              :value="opt.value"
            >
              {{ opt.label }}
            </option>
          </slot>
        </select>
        <span class="field__select-caret" aria-hidden="true" />
      </div>

      <input
        v-else
        :id="fieldId"
        class="field__control"
        :class="{ 'field__control--mono': mono }"
        :type="type"
        :placeholder="placeholder"
        :disabled="disabled"
        :required="required"
        v-model="textModel"
      />
    </template>

    <p v-if="error" class="field__error">{{ error }}</p>
    <p v-else-if="hint" class="field__hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  min-width: 0;
}

/* Label — docs h5 treatment: 12px mono allcaps, primary blue */
.field__label {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--docs-primary);
}

.field--error .field__label {
  color: var(--status-danger);
}

.field__required {
  color: var(--status-danger);
  margin-left: 2px;
}

.field__control {
  font-family: var(--font-sans);
  font-size: 14px;
  color: var(--docs-text);
  background: var(--docs-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius);
  padding: 0.5rem 0.75rem;
  width: 100%;
  transition: border-color 0.15s ease, box-shadow 0.15s ease,
    background-color 0.15s ease;
}

.field__control--mono {
  font-family: var(--font-mono);
  font-size: 13px;
}

.field__control::placeholder {
  color: var(--docs-text-muted);
}

.field__control:hover:not(:disabled):not(:focus) {
  border-color: #9ca3af;
}

.field__control:focus {
  outline: none;
  border-color: var(--docs-primary);
  box-shadow: var(--focus-ring);
}

.field__control:disabled {
  background: var(--docs-bg-subtle);
  color: var(--docs-text-muted);
  cursor: not-allowed;
}

.field--error .field__control {
  border-color: var(--status-danger);
}

.field--error .field__control:focus {
  box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.2);
}

.field__control--textarea {
  resize: vertical;
  min-height: 4.5rem;
  line-height: 1.5;
}

/* select with angular caret (docs pagination caret style) */
.field__select-wrap {
  position: relative;
}

.field__control--select {
  appearance: none;
  padding-right: 2rem;
  cursor: pointer;
}

.field__select-caret {
  position: absolute;
  right: 0.85rem;
  top: 50%;
  width: 7px;
  height: 7px;
  border-style: solid;
  border-color: var(--docs-text-secondary);
  border-width: 0 1.5px 1.5px 0;
  transform: translateY(-70%) rotate(45deg);
  pointer-events: none;
}

/* checkbox (docs task-list: accent-color primary) */
.field__check {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-size: 14px;
  color: var(--docs-text);
}

.field__checkbox {
  width: 1rem;
  height: 1rem;
  margin: 0;
  accent-color: var(--docs-primary);
  cursor: pointer;
}

.field__checkbox:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.field--disabled .field__check {
  cursor: not-allowed;
  color: var(--docs-text-muted);
}

.field__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--docs-text-muted);
}

.field__error {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  font-weight: 500;
  color: var(--status-danger);
}
</style>
