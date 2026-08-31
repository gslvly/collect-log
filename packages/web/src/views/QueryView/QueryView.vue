<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { getApiErrorMessage } from '../../api/errors.js';
import {
  queryTableRows,
  type DetailQueryInput,
  type DetailRow,
  type ExportInput,
  type QueryOrder,
  type TimeRange,
} from '../../api/query.js';
import {
  getTableDetail,
  listTables,
  type CollectionField,
  type CollectionTable,
} from '../../api/tables.js';
import { useTimezoneStore } from '../../stores/timezone.js';
import { useFieldTypesStore } from '../../stores/field-types.js';
import QueryFilterGroup from './QueryFilterGroup.vue';
import QueryResultPanel from './QueryResultPanel.vue';
import QueryTableSelector from './QueryTableSelector.vue';
import { useQueryExport } from './query-export.js';
import {
  QUERY_PAGE_SIZE,
  buildQueryFilter,
  createDefaultTimeRange,
  createFilterGroup,
  getQueryableTables,
  isQueryTableReady,
  pickerRangeToTimeRange,
  queryInputSignature,
  timeRangeToPickerRange,
  validateTimeRange,
  type FilterGroupDraft,
} from './query.logic.js';

const route = useRoute();
const router = useRouter();
const timezoneStore = useTimezoneStore();
const fieldTypesStore = useFieldTypesStore();

const tableOptions = ref<CollectionTable[]>([]);
const selectedProjectId = ref('');
const selectedTable = ref<CollectionTable | null>(null);
const fields = ref<CollectionField[]>([]);
const tablesLoading = ref(false);
const tablesError = ref('');
const detailLoading = ref(false);
const detailError = ref('');
const routeProjectNotice = ref('');
const tablesReady = ref(false);

const timeRange = ref<TimeRange | null>(createDefaultTimeRange());
const filterRoot = ref<FilterGroupDraft>(createFilterGroup());
const includeFields = ref<string[]>([]);
const order = ref<QueryOrder>('desc');

const queryLoading = ref(false);
const queryError = ref('');
const resultLoaded = ref(false);
const rows = ref<DetailRow[]>([]);
const nextCursor = ref<string | null>(null);
const cursorStack = ref<Array<string | null>>([null]);
const cursorIndex = ref(0);
let requestSequence = 0;


const queryableFields = computed(() =>
  fields.value.filter((field) => field.status === 'active' || field.status === 'deprecated'),
);
const deprecatedFields = computed(() =>
  fields.value.filter((field) => field.status === 'deprecated'),
);
const filterBuild = computed(() =>
  buildQueryFilter(filterRoot.value, queryableFields.value, fieldTypesStore.response),
);
const rangeError = computed(() =>
  validateTimeRange(timeRange.value, fieldTypesStore.response?.limits ?? null),
);
const maxConditions = computed(() => fieldTypesStore.response?.limits.maxConditions ?? null);
const pageNumber = computed(() => cursorIndex.value + 1);

const pickerRange = computed<[Date, Date] | null>({
  get: () =>
    timeRange.value === null
      ? null
      : timeRangeToPickerRange(timeRange.value, timezoneStore.timeZone),
  set: (value) => {
    timeRange.value = pickerRangeToTimeRange(value, timezoneStore.timeZone);
  },
});

const inputSignature = computed(() =>
  queryInputSignature({
    projectId: selectedProjectId.value,
    range: timeRange.value,
    filter: filterRoot.value,
    includeFields: includeFields.value,
    order: order.value,
    schemaVersion: selectedTable.value?.schemaVersion ?? null,
  }),
);

function resetQueryResult(): void {
  requestSequence += 1;
  queryLoading.value = false;
  queryError.value = '';
  resultLoaded.value = false;
  rows.value = [];
  nextCursor.value = null;
  cursorStack.value = [null];
  cursorIndex.value = 0;
}

watch(inputSignature, () => {
  resetQueryResult();
});

function resetProjectInputs(): void {
  timeRange.value = createDefaultTimeRange();
  filterRoot.value = createFilterGroup();
  includeFields.value = [];
  order.value = 'desc';
  fields.value = [];
  selectedTable.value = null;
  detailError.value = '';
  routeProjectNotice.value = '';
  resetQueryResult();
}

function buildDetailInput(cursor: string | null): DetailQueryInput | null {
  if (selectedProjectId.value === '') {
    ElMessage.warning('请先选择数据采集表');
    return null;
  }
  if (selectedTable.value === null || !isQueryTableReady(selectedTable.value.status)) {
    ElMessage.warning('数据采集表尚未就绪');
    return null;
  }
  if (rangeError.value !== undefined || timeRange.value === null) {
    ElMessage.warning(rangeError.value ?? '请选择时间范围');
    return null;
  }
  if (!filterBuild.value.valid) {
    ElMessage.warning(filterBuild.value.message ?? '查询条件不正确');
    return null;
  }
  const input: DetailQueryInput = {
    range: timeRange.value,
    includeFields: [...includeFields.value],
    limit: QUERY_PAGE_SIZE,
    order: order.value,
  };
  if (filterBuild.value.filter !== undefined) {
    input.filter = filterBuild.value.filter;
  }
  if (cursor !== null) {
    input.cursor = cursor;
  }
  return input;
}

async function loadPage(cursor: string | null, targetIndex: number): Promise<void> {
  const input = buildDetailInput(cursor);
  if (input === null) {
    return;
  }
  const sequence = ++requestSequence;
  queryLoading.value = true;
  queryError.value = '';
  try {
    const response = await queryTableRows(selectedProjectId.value, input);
    if (sequence !== requestSequence) {
      return;
    }
    rows.value = response.rows;
    nextCursor.value = response.nextCursor;
    cursorStack.value = [...cursorStack.value.slice(0, targetIndex), cursor];
    cursorIndex.value = targetIndex;
    resultLoaded.value = true;
  } catch (error) {
    if (sequence === requestSequence) {
      queryError.value = getApiErrorMessage(error);
    }
  } finally {
    if (sequence === requestSequence) {
      queryLoading.value = false;
    }
  }
}

async function runFirstPage(): Promise<void> {
  resetQueryResult();
  await loadPage(null, 0);
}

async function goNextPage(): Promise<void> {
  if (nextCursor.value === null) {
    return;
  }
  await loadPage(nextCursor.value, cursorIndex.value + 1);
}

async function goPreviousPage(): Promise<void> {
  if (cursorIndex.value === 0) {
    return;
  }
  const targetIndex = cursorIndex.value - 1;
  await loadPage(cursorStack.value[targetIndex] ?? null, targetIndex);
}

function clearFilter(): void {
  filterRoot.value = createFilterGroup();
}

function buildExportInput(): ExportInput | null {
  const detailInput = buildDetailInput(null);
  if (detailInput === null) {
    return null;
  }
  const input: ExportInput = {
    range: detailInput.range,
    includeFields: [...includeFields.value],
    order: order.value,
  };
  if (detailInput.filter !== undefined) {
    input.filter = detailInput.filter;
  }
  return input;
}

const { exportLoading, handleExport } = useQueryExport(selectedProjectId, buildExportInput);

async function loadSelectedTable(autoQuery: boolean): Promise<void> {
  if (selectedProjectId.value === '') {
    return;
  }
  detailLoading.value = true;
  detailError.value = '';
  try {
    const response = await getTableDetail(selectedProjectId.value);
    selectedTable.value = response.table;
    fields.value = response.fields;
    if (!isQueryTableReady(response.table.status)) {
      routeProjectNotice.value = '该表尚未就绪，暂时不能查询';
      return;
    }
    await nextTick();
    if (autoQuery) {
      await runFirstPage();
    }
  } catch (error) {
    detailError.value = getApiErrorMessage(error);
  } finally {
    detailLoading.value = false;
  }
}

async function selectProject(
  projectId: string,
  options: { syncUrl: boolean; autoQuery: boolean },
): Promise<void> {
  selectedProjectId.value = projectId;
  resetProjectInputs();

  if (options.syncUrl) {
    await router.replace({ name: 'query', query: projectId === '' ? {} : { projectId } });
  }
  await loadSelectedTable(options.autoQuery);
}

async function handleProjectChange(value: string): Promise<void> {
  await selectProject(value, { syncUrl: true, autoQuery: value !== '' });
}

async function loadTableOptions(): Promise<void> {
  tablesLoading.value = true;
  tablesError.value = '';
  try {
    const response = await listTables();
    tableOptions.value = getQueryableTables(response.tables);
    tablesReady.value = true;
    const requested = typeof route.query.projectId === 'string' ? route.query.projectId : '';
    if (requested === '') {
      return;
    }
    if (tableOptions.value.some((table) => table.projectId === requested)) {
      await selectProject(requested, { syncUrl: false, autoQuery: true });
      return;
    }
    const unavailable = response.tables.find((table) => table.projectId === requested);
    routeProjectNotice.value =
      unavailable?.status === 'creating' || unavailable?.status === 'failed'
        ? '链接中的数据采集表尚未就绪，请选择其他表'
        : '链接中的数据采集表不存在，请重新选择';
  } catch (error) {
    tablesError.value = getApiErrorMessage(error);
  } finally {
    tablesLoading.value = false;
  }
}

watch(
  () => route.query.projectId,
  (value) => {
    if (!tablesReady.value) {
      return;
    }
    const projectId = typeof value === 'string' ? value : '';
    if (projectId === selectedProjectId.value) {
      return;
    }
    if (projectId === '' || tableOptions.value.some((table) => table.projectId === projectId)) {
      void selectProject(projectId, { syncUrl: false, autoQuery: projectId !== '' });
    }
  },
);

function loadFieldTypes(): void {
  void fieldTypesStore.load().catch(() => {
    // The store keeps the message for the inline retry state.
  });
}

onMounted(() => {
  loadFieldTypes();
  void loadTableOptions();
});
</script>

<template>
  <section class="query-page">
    <QueryTableSelector
      :selected-project-id="selectedProjectId"
      :table-options="tableOptions"
      :loading="tablesLoading"
      :error="tablesError"
      :route-notice="routeProjectNotice"
      @change="handleProjectChange"
      @reload="loadTableOptions"
    />

    <el-card v-if="selectedProjectId" shadow="never" class="query-card">
      <el-skeleton v-if="detailLoading && selectedTable === null" :rows="5" animated />
      <el-alert
        v-else-if="detailError"
        :title="detailError"
        type="error"
        :closable="false"
        show-icon
      >
        <template #default>
          <el-button link type="primary" @click="loadSelectedTable(false)">重新加载</el-button>
        </template>
      </el-alert>

      <template v-else-if="selectedTable">
        <div class="table-context">
          <div>
            <span>当前表</span>
            <strong>{{ selectedTable.displayName }}</strong>
            <code>{{ selectedTable.projectId }}</code>
          </div>
          <el-button link type="primary" @click="router.push(`/tables/${selectedTable.projectId}`)">
            查看表详情
          </el-button>
        </div>

        <div class="input-grid">
          <div class="control-block control-block--time">
            <label>时间范围 <em>必填</em></label>
            <el-date-picker
              v-model="pickerRange"
              type="datetimerange"
              start-placeholder="开始时间"
              end-placeholder="结束时间"
              range-separator="至"
              format="YYYY-MM-DD HH:mm:ss"
              :clearable="true"
            />
            <small v-if="rangeError" class="validation-error">{{ rangeError }}</small>
          </div>

          <div class="control-block">
            <label>排序</label>
            <el-radio-group v-model="order">
              <el-radio-button value="desc">最新优先</el-radio-button>
              <el-radio-button value="asc">最早优先</el-radio-button>
            </el-radio-group>
          </div>

          <div class="control-block">
            <label>同时查看已废弃字段</label>
            <el-select
              v-model="includeFields"
              multiple
              filterable
              collapse-tags
              collapse-tags-tooltip
              :disabled="deprecatedFields.length === 0"
              :placeholder="deprecatedFields.length === 0 ? '没有已废弃字段' : '默认不包含'"
            >
              <el-option
                v-for="field in deprecatedFields"
                :key="field.key"
                :label="field.key"
                :value="field.key"
              />
            </el-select>
          </div>
        </div>

        <section class="filter-section">
          <header class="filter-heading">
            <div>
              <h3>条件构造器</h3>
              <p>可查询 active 与 deprecated 字段；系统列不作为筛选字段。</p>
            </div>
            <div
              class="condition-budget"
              :class="{ exhausted: maxConditions !== null && filterBuild.count > maxConditions }"
            >
              <span>已用</span>
              <strong>{{ filterBuild.count }}</strong>
              <span>/ {{ maxConditions ?? '—' }}</span>
            </div>
          </header>
          <el-alert
            v-if="fieldTypesStore.error"
            :title="fieldTypesStore.error"
            type="error"
            :closable="false"
            show-icon
          >
            <template #default>
              <el-button link type="primary" @click="loadFieldTypes">重新加载类型能力</el-button>
            </template>
          </el-alert>
          <el-skeleton v-else-if="fieldTypesStore.response === null" :rows="3" animated />
          <QueryFilterGroup
            v-else
            v-model:group="filterRoot"
            :fields="queryableFields"
            :field-types="fieldTypesStore.response"
            :time-zone="timezoneStore.timeZone"
            :depth="1"
            root
          />
          <div class="filter-footer">
            <span v-if="!filterBuild.valid" class="validation-error">{{
              filterBuild.message
            }}</span>
            <span v-else>条件留空时查询整个时间范围。</span>
            <el-button link :disabled="filterRoot.conditions.length === 0" @click="clearFilter">
              清空全部条件
            </el-button>
          </div>
        </section>

        <div class="query-actions">
          <el-button type="primary" :loading="queryLoading" @click="runFirstPage">
            查询第一页
          </el-button>
          <el-button :loading="exportLoading" @click="handleExport">导出当前条件 CSV</el-button>
          <span>每页最多 {{ QUERY_PAGE_SIZE }} 条</span>
        </div>
      </template>
    </el-card>

    <QueryResultPanel
      v-if="selectedTable"
      :project-id="selectedProjectId"
      :fields="fields"
      :rows="rows"
      :loading="queryLoading"
      :error="queryError"
      :loaded="resultLoaded"
      :page-number="pageNumber"
      :cursor-index="cursorIndex"
      :next-cursor="nextCursor"
      @previous="goPreviousPage"
      @next="goNextPage"
    />

    <el-card v-else-if="!tablesLoading" shadow="never" class="empty-selection">
      <el-empty description="请先在页面顶部选择一张数据采集表" />
    </el-card>
  </section>
</template>

<style scoped src="./query-view.css"></style>
