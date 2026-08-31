<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { DetailRow } from '../../api/query.js';
import type { CollectionField } from '../../api/tables.js';
import { formatCellValue, getCellKind, getColumnLabel, getColumnWidth } from '../../detail-rows.js';
import { useTimezoneStore } from '../../stores/timezone.js';
import {
  columnStorageKey,
  getResultColumns,
  moveColumn,
  parseColumnPreference,
  reconcileColumnPreference,
  type ColumnPreference,
} from './query.logic.js';

const props = defineProps<{
  projectId: string;
  fields: CollectionField[];
  rows: DetailRow[];
  loading: boolean;
  error: string;
  loaded: boolean;
  pageNumber: number;
  cursorIndex: number;
  nextCursor: string | null;
}>();
const emit = defineEmits<{ previous: []; next: [] }>();

const timezoneStore = useTimezoneStore();
const serverColumns = ref<string[]>([]);
const columnPreference = ref<ColumnPreference>({ order: [], hidden: [] });
const draggedColumnIndex = ref<number | null>(null);
const visibleColumns = computed(() => {
  const hidden = new Set(columnPreference.value.hidden);
  return columnPreference.value.order.filter((column) => !hidden.has(column));
});

function readColumnPreference(projectId: string): ColumnPreference | null {
  try {
    return parseColumnPreference(localStorage.getItem(columnStorageKey(projectId)));
  } catch {
    return null;
  }
}

function persistColumnPreference(): void {
  if (props.projectId === '') {
    return;
  }
  try {
    localStorage.setItem(columnStorageKey(props.projectId), JSON.stringify(columnPreference.value));
  } catch {
    // Column preferences remain available for the current page when storage is unavailable.
  }
}

function applyReturnedColumns(resultRows: DetailRow[]): void {
  const returned = getResultColumns(resultRows);
  serverColumns.value = returned;
  if (returned.length === 0) {
    return;
  }
  columnPreference.value = reconcileColumnPreference(returned, columnPreference.value);
  persistColumnPreference();
}

function isColumnVisible(column: string): boolean {
  return !columnPreference.value.hidden.includes(column);
}

function toggleColumn(column: string, visible: boolean): void {
  const hidden = new Set(columnPreference.value.hidden);
  if (visible) {
    hidden.delete(column);
  } else {
    hidden.add(column);
  }
  columnPreference.value = { ...columnPreference.value, hidden: [...hidden] };
  persistColumnPreference();
}

function handleColumnDrop(targetIndex: number): void {
  if (draggedColumnIndex.value === null) {
    return;
  }
  columnPreference.value = {
    ...columnPreference.value,
    order: moveColumn(columnPreference.value.order, draggedColumnIndex.value, targetIndex),
  };
  draggedColumnIndex.value = null;
  persistColumnPreference();
}

function cellText(row: DetailRow, column: string): string {
  return formatCellValue(row[column], column, (value) => timezoneStore.formatUtc(value));
}

watch(
  () => props.projectId,
  (projectId) => {
    serverColumns.value = [];
    columnPreference.value =
      projectId === ''
        ? { order: [], hidden: [] }
        : (readColumnPreference(projectId) ?? { order: [], hidden: [] });
  },
  { immediate: true },
);

watch(
  () => props.rows,
  (rows) => applyReturnedColumns(rows),
);
</script>

<template>
  <el-card shadow="never" class="result-card">
    <template #header>
      <div class="result-heading">
        <div>
          <h3>查询结果</h3>
          <p v-if="loaded">第 {{ pageNumber }} 页 · 本页 {{ rows.length }} 条</p>
          <p v-else>设置条件后开始查询</p>
        </div>
        <el-popover
          v-if="serverColumns.length > 0"
          placement="bottom-end"
          :width="340"
          trigger="click"
        >
          <template #reference>
            <el-button>列设置 · {{ visibleColumns.length }}/{{ serverColumns.length }}</el-button>
          </template>
          <div class="column-manager">
            <p>拖动调整顺序；勾选控制显示。</p>
            <div
              v-for="(column, index) in columnPreference.order"
              :key="column"
              class="column-option"
              draggable="true"
              @dragstart="draggedColumnIndex = index"
              @dragover.prevent
              @drop="handleColumnDrop(index)"
            >
              <span class="drag-handle" aria-hidden="true">⋮⋮</span>
              <el-checkbox
                :model-value="isColumnVisible(column)"
                @change="toggleColumn(column, Boolean($event))"
              >
                {{ getColumnLabel(column, fields) }}
              </el-checkbox>
              <code>{{ column }}</code>
            </div>
          </div>
        </el-popover>
      </div>
    </template>

    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-skeleton v-if="loading && !loaded" :rows="6" animated />
    <el-empty v-else-if="!loaded" description="尚未执行查询" />
    <el-empty v-else-if="rows.length === 0" description="当前条件下没有记录" />
    <el-empty v-else-if="visibleColumns.length === 0" description="所有结果列都已隐藏">
      <span>请从右上角“列设置”重新显示需要的列。</span>
    </el-empty>
    <el-table v-else :data="rows" row-key="_record_id" max-height="620" class="result-table">
      <el-table-column
        v-for="column in visibleColumns"
        :key="column"
        :prop="column"
        :label="getColumnLabel(column, fields)"
        :min-width="getColumnWidth(column)"
        show-overflow-tooltip
      >
        <template #header>
          <div class="column-heading">
            <strong>{{ getColumnLabel(column, fields) }}</strong>
            <code>{{ column }}</code>
          </div>
        </template>
        <template #default="scope">
          <el-tag
            v-if="getCellKind(scope.row[column]) === 'boolean-true'"
            type="success"
            effect="light"
          >
            true
          </el-tag>
          <el-tag
            v-else-if="getCellKind(scope.row[column]) === 'boolean-false'"
            type="info"
            effect="plain"
          >
            false
          </el-tag>
          <span v-else-if="getCellKind(scope.row[column]) === 'unset'" class="unset-value">
            未提交
          </span>
          <span
            v-else
            :class="{ 'empty-string': getCellKind(scope.row[column]) === 'empty-string' }"
          >
            {{ cellText(scope.row, column) }}
          </span>
        </template>
      </el-table-column>
    </el-table>

    <footer v-if="loaded" class="pagination-row">
      <span>游标分页 · 第 {{ pageNumber }} 页</span>
      <div>
        <el-button :disabled="cursorIndex === 0 || loading" @click="emit('previous')">
          上一页
        </el-button>
        <el-button :disabled="nextCursor === null || loading" @click="emit('next')">
          下一页
        </el-button>
      </div>
    </footer>
  </el-card>
</template>

<style scoped src="./query-result-panel.css"></style>
