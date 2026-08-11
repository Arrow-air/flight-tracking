<script setup lang="ts">
/**
 * AppTable — port of the Arrow docs table style: solid #0843BF header row
 * with Departure Mono allcaps white labels and the darker #0636A0 rules,
 * condensed bordered cells (#e5e7eb), Neue Haas 14px body.
 *
 * Two usage modes:
 *  1. Data-driven: pass `columns` (+ `rows`); customize any cell with a
 *     scoped slot named `cell-<key>` receiving { row, value }.
 *     Make a row clickable by handling @row-click.
 *  2. Free-form: use the default slot to provide your own
 *     <thead>/<tbody> markup and inherit the styling.
 */
export interface TableColumn {
  key: string;
  label: string;
  /** e.g. '120px' or '20%' */
  width?: string;
  align?: 'left' | 'right' | 'center';
  /** render value in mono (ids, tail numbers, timestamps) */
  mono?: boolean;
}

type Row = Record<string, unknown>;

const props = withDefaults(
  defineProps<{
    columns?: TableColumn[];
    rows?: Row[];
    /** key used for v-for keys; falls back to row index */
    rowKey?: string;
    /** enable hover highlight + pointer cursor on rows */
    clickable?: boolean;
    /** message when rows is empty */
    emptyText?: string;
  }>(),
  { emptyText: 'No records.' },
);

const emit = defineEmits<{ (e: 'row-click', row: Row): void }>();

function keyFor(row: Row, index: number): string | number {
  if (props.rowKey && row[props.rowKey] != null) {
    return String(row[props.rowKey]);
  }
  return index;
}
</script>

<template>
  <div class="table-wrap">
    <table class="table">
      <template v-if="columns">
        <colgroup>
          <col
            v-for="col in columns"
            :key="col.key"
            :style="col.width ? { width: col.width } : undefined"
          />
        </colgroup>
        <thead>
          <tr>
            <th
              v-for="col in columns"
              :key="col.key"
              :style="col.align ? { textAlign: col.align } : undefined"
            >
              {{ col.label }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, i) in rows ?? []"
            :key="keyFor(row, i)"
            :class="{ 'is-clickable': clickable }"
            @click="clickable && emit('row-click', row)"
          >
            <td
              v-for="col in columns"
              :key="col.key"
              :class="{ 'cell-mono': col.mono }"
              :style="col.align ? { textAlign: col.align } : undefined"
            >
              <slot
                :name="`cell-${col.key}`"
                :row="row"
                :value="row[col.key]"
              >
                {{ row[col.key] ?? '—' }}
              </slot>
            </td>
          </tr>
          <tr v-if="!rows || rows.length === 0">
            <td class="table__empty" :colspan="columns.length">
              {{ emptyText }}
            </td>
          </tr>
        </tbody>
      </template>
      <slot v-else />
    </table>
  </div>
</template>

<style scoped>
.table-wrap {
  overflow-x: auto;
  margin: 0 0 1rem 0;
}

.table {
  font-family: var(--font-sans);
  font-size: 14px;
  letter-spacing: 0;
  display: table;
  border-collapse: separate;
  border-spacing: 0;
  width: 100%;
  line-height: 1.4;
}

.table :deep(th) {
  font-family: var(--font-mono-display);
  font-size: 12px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  text-align: left;
  padding: 0.5rem 0.75rem;
  background: var(--docs-primary);
  border: none;
  border-top: 1px solid #0636a0;
  border-bottom: 2px solid #0636a0;
  border-left: 1px solid #0636a0;
  color: #ffffff;
}

.table :deep(th:last-child) {
  border-right: 1px solid var(--docs-border);
}

.table :deep(td) {
  padding: 0.375rem 0.75rem;
  border: none;
  border-top: 1px solid var(--docs-border);
  border-left: 1px solid var(--docs-border);
  color: var(--docs-text-secondary);
  transition: background-color 0.1s ease;
}

.table :deep(td:last-child) {
  border-right: 1px solid var(--docs-border);
}

.table :deep(tbody tr:first-child td) {
  border-top: none;
}

.table :deep(tr:last-child td) {
  border-bottom: 1px solid var(--docs-border);
}

/* Row interaction (app addition — docs tables are static) */
.table :deep(tr.is-clickable) {
  cursor: pointer;
}

.table :deep(tr.is-clickable:hover td) {
  background: var(--docs-primary-light);
}

.cell-mono {
  font-family: var(--font-mono);
  font-size: 13px;
}

.table__empty {
  text-align: center;
  color: var(--docs-text-muted);
  font-style: italic;
  padding: 1rem 0.75rem !important;
}
</style>
