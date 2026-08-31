<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { getApiErrorMessage } from '../../api/errors.js';
import {
  getTableStatistics,
  type StatisticsInput,
  type StatisticsResponse,
  type TimeRange,
} from '../../api/query.js';
import { getTableDetail, type CollectionField, type CollectionTable } from '../../api/tables.js';
import { useFieldTypesStore } from '../../stores/field-types.js';
import { useTimezoneStore } from '../../stores/timezone.js';
import QueryFilterGroup from '../QueryView/QueryFilterGroup.vue';
import {
  buildQueryFilter,
  createDefaultTimeRange,
  createFilterGroup,
  getQueryableTables,
  isQueryTableReady,
  pickerRangeToTimeRange,
  timeRangeToPickerRange,
  validateTimeRange,
  type FilterGroupDraft,
} from '../QueryView/query.logic.js';
import { listTables } from '../../api/tables.js';
import {
  GRANULARITY_LABELS,
  HIGH_CARDINALITY_NOTICE,
  buildStatisticsInput,
  createStatisticsDraft,
} from './statistics.logic.js';
import StatisticsResultPanel from './StatisticsResultPanel.vue';
import StatisticsTableSelector from './StatisticsTableSelector.vue';
import { useStatisticsOptions } from './statistics-options.js';

const route = useRoute();
const router = useRouter();
const timezoneStore = useTimezoneStore();
const fieldTypesStore = useFieldTypesStore();

const tableOptions = ref<CollectionTable[]>([]);
const tablesLoading = ref(false);
const tablesError = ref('');
const tablesReady = ref(false);
const routeProjectNotice = ref('');

const selectedProjectId = ref('');
const selectedTable = ref<CollectionTable | null>(null);
const fields = ref<CollectionField[]>([]);
const detailLoading = ref(false);
const detailError = ref('');

const timeRange = ref<TimeRange | null>(createDefaultTimeRange());
const filterRoot = ref<FilterGroupDraft>(createFilterGroup());
const draft = ref(createStatisticsDraft());

const statisticsLoading = ref(false);
const statisticsError = ref('');
const result = ref<StatisticsResponse | null>(null);
let requestSequence = 0;

const queryableFields = computed(() =>
  fields.value.filter((field) => field.status === 'active' || field.status === 'deprecated'),
);
const rangeError = computed(() =>
  validateTimeRange(timeRange.value, fieldTypesStore.response?.limits ?? null),
);
const filterBuild = computed(() =>
  buildQueryFilter(filterRoot.value, queryableFields.value, fieldTypesStore.response),
);

const {
  defaultGroupLimit,
  dimensionFieldOptions,
  fnNeedsField,
  highCardinalityNotice,
  measureFieldOptions,
  measureLabel,
  measureOptions,
  onDimensionKindChange,
  onMeasureChange,
  selectedDimensionField,
  timeAxisOptions,
} = useStatisticsOptions(queryableFields, draft, resetResult);

const pickerRange = computed<[Date, Date] | null>({
  get: () =>
    timeRange.value === null
      ? null
      : timeRangeToPickerRange(timeRange.value, timezoneStore.timeZone),
  set: (value) => {
    timeRange.value = pickerRangeToTimeRange(value, timezoneStore.timeZone);
  },
});

const buildResult = computed(() =>
  buildStatisticsInput(draft.value, {
    range: timeRange.value,
    tz: timezoneStore.timeZone,
    ...(filterBuild.value.filter === undefined ? {} : { filter: filterBuild.value.filter }),
    fields: queryableFields.value,
    fieldTypes: fieldTypesStore.response,
  }),
);

function resetResult(): void {
  requestSequence += 1;
  result.value = null;
  statisticsError.value = '';
  statisticsLoading.value = false;
}

function resetProjectInputs(): void {
  timeRange.value = createDefaultTimeRange();
  filterRoot.value = createFilterGroup();
  draft.value = createStatisticsDraft();
  fields.value = [];
  selectedTable.value = null;
  detailError.value = '';
  routeProjectNotice.value = '';
  resetResult();
}

async function runStatistics(): Promise<void> {
  if (selectedProjectId.value === '' || selectedTable.value === null) {
    ElMessage.warning('请先选择数据采集表');
    return;
  }
  if (rangeError.value !== undefined) {
    ElMessage.warning(rangeError.value);
    return;
  }
  if (!filterBuild.value.valid) {
    ElMessage.warning(filterBuild.value.message ?? '查询条件不正确');
    return;
  }
  if (!buildResult.value.valid || buildResult.value.input === undefined) {
    ElMessage.warning(buildResult.value.message ?? '统计条件不正确');
    return;
  }

  const input: StatisticsInput = buildResult.value.input;
  const sequence = ++requestSequence;
  statisticsLoading.value = true;
  statisticsError.value = '';
  try {
    const response = await getTableStatistics(selectedProjectId.value, input);
    if (sequence !== requestSequence) {
      return;
    }
    result.value = response;
  } catch (error) {
    if (sequence === requestSequence) {
      statisticsError.value = getApiErrorMessage(error);
      result.value = null;
    }
  } finally {
    if (sequence === requestSequence) {
      statisticsLoading.value = false;
    }
  }
}

async function loadSelectedTable(): Promise<void> {
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
      routeProjectNotice.value = '该表尚未就绪，暂时不能统计';
    }
  } catch (error) {
    detailError.value = getApiErrorMessage(error);
  } finally {
    detailLoading.value = false;
  }
}

async function selectProject(projectId: string, options: { syncUrl: boolean }): Promise<void> {
  selectedProjectId.value = projectId;
  resetProjectInputs();
  if (options.syncUrl) {
    await router.replace({ name: 'statistics', query: projectId === '' ? {} : { projectId } });
  }
  await loadSelectedTable();
}

async function handleProjectChange(value: string): Promise<void> {
  await selectProject(value, { syncUrl: true });
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
      await selectProject(requested, { syncUrl: false });
      return;
    }
    routeProjectNotice.value = '链接中的数据采集表不可统计，请重新选择';
  } catch (error) {
    tablesError.value = getApiErrorMessage(error);
  } finally {
    tablesLoading.value = false;
  }
}

function loadFieldTypes(): void {
  void fieldTypesStore.load().catch(() => {
    // The store keeps the message for the inline retry state.
  });
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
      void selectProject(projectId, { syncUrl: false });
    }
  },
);

onMounted(() => {
  loadFieldTypes();
  void loadTableOptions();
});
</script>

<template>
  <section class="statistics-page">
    <StatisticsTableSelector
      :selected-project-id="selectedProjectId"
      :table-options="tableOptions"
      :loading="tablesLoading"
      :error="tablesError"
      :route-notice="routeProjectNotice"
      @change="handleProjectChange"
      @reload="loadTableOptions"
    />

    <el-card v-if="selectedProjectId" shadow="never" class="builder-card">
      <el-skeleton v-if="detailLoading && selectedTable === null" :rows="5" animated />
      <el-alert
        v-else-if="detailError"
        :title="detailError"
        type="error"
        :closable="false"
        show-icon
      >
        <template #default>
          <el-button link type="primary" @click="loadSelectedTable">重新加载</el-button>
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
        <el-skeleton v-else-if="fieldTypesStore.response === null" :rows="4" animated />

        <template v-else>
          <div class="axis-grid">
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
              <label>按什么分组</label>
              <el-select v-model="draft.dimensionKind" @change="onDimensionKindChange">
                <el-option value="none" label="不分组（返回单个值）" />
                <el-option value="time" label="时间" />
                <el-option
                  value="field"
                  label="某个字段"
                  :disabled="dimensionFieldOptions.length === 0"
                />
              </el-select>
              <small v-if="dimensionFieldOptions.length === 0">
                该表没有可分组字段，只能按时间或不分组。
              </small>
            </div>

            <div v-if="draft.dimensionKind === 'time'" class="control-block">
              <label>时间轴</label>
              <el-select v-model="draft.axis" @change="resetResult">
                <el-option
                  v-for="axis in timeAxisOptions"
                  :key="axis.key"
                  :value="axis.key"
                  :label="axis.deprecated ? `${axis.label}（已废弃）` : axis.label"
                />
              </el-select>
              <small v-if="draft.axis !== '_occurred_at'">
                业务时间轴不做空桶填充，未提交该字段的行会以 nullAxisRows 单独返回。
              </small>
            </div>

            <div v-if="draft.dimensionKind === 'time'" class="control-block">
              <label>时间粒度</label>
              <el-select v-model="draft.granularity" @change="resetResult">
                <el-option
                  v-for="(label, value) in GRANULARITY_LABELS"
                  :key="value"
                  :value="value"
                  :label="label"
                />
              </el-select>
              <small>按分钟不超过 2 天，按小时不超过 31 天。</small>
            </div>

            <div v-if="draft.dimensionKind === 'field'" class="control-block">
              <label>分组字段</label>
              <el-select v-model="draft.dimensionField" filterable @change="resetResult">
                <el-option
                  v-for="option in dimensionFieldOptions"
                  :key="option.key"
                  :value="option.key"
                  :label="option.key"
                >
                  <span class="option-row">
                    <strong>{{ option.key }}</strong>
                    <em>{{ option.label }}</em>
                    <el-tag v-if="option.deprecated" size="small" type="warning">已废弃</el-tag>
                    <el-tag v-if="option.highCardinality" size="small" type="info">
                      {{ HIGH_CARDINALITY_NOTICE }}
                    </el-tag>
                  </span>
                </el-option>
              </el-select>
              <small v-if="highCardinalityNotice" class="hint-warning">
                {{ highCardinalityNotice }}
              </small>
            </div>

            <div v-if="draft.dimensionKind === 'field'" class="control-block">
              <label>分组数量（Top N）</label>
              <el-input-number
                v-model="draft.groupLimit"
                :min="1"
                :max="fieldTypesStore.response.limits.maxGroupLimit"
                :placeholder="`默认 ${defaultGroupLimit ?? ''}`"
                controls-position="right"
                @change="resetResult"
              />
              <small>留空则使用服务端默认值 {{ defaultGroupLimit }}。</small>
            </div>

            <div class="control-block">
              <label>统计什么</label>
              <el-select v-model="draft.fn" @change="onMeasureChange">
                <el-option
                  v-for="measure in measureOptions"
                  :key="measure.fn"
                  :value="measure.fn"
                  :label="measure.label"
                />
              </el-select>
            </div>

            <div v-if="fnNeedsField" class="control-block">
              <label>指标字段</label>
              <el-select
                v-model="draft.measureField"
                filterable
                :placeholder="
                  measureFieldOptions.length === 0 ? '没有支持该指标的字段' : '请选择字段'
                "
                @change="resetResult"
              >
                <el-option
                  v-for="option in measureFieldOptions"
                  :key="option.key"
                  :value="option.key"
                  :label="option.key"
                >
                  <span class="option-row">
                    <strong>{{ option.key }}</strong>
                    <em>{{ option.label }}</em>
                    <el-tag v-if="option.deprecated" size="small" type="warning">已废弃</el-tag>
                  </span>
                </el-option>
              </el-select>
              <small>字段列表已按该指标需要的能力过滤。</small>
            </div>
          </div>

          <section class="filter-section">
            <header class="filter-heading">
              <div>
                <h3>筛选条件（可选）</h3>
                <p>与明细查询共用同一套条件构造器与能力矩阵。</p>
              </div>
            </header>
            <QueryFilterGroup
              v-model:group="filterRoot"
              :fields="queryableFields"
              :field-types="fieldTypesStore.response"
              :time-zone="timezoneStore.timeZone"
              :depth="1"
              root
              @change="resetResult"
            />
            <div class="filter-footer">
              <span v-if="!filterBuild.valid" class="validation-error">
                {{ filterBuild.message }}
              </span>
              <span v-else>条件留空时统计整个时间范围。</span>
            </div>
          </section>

          <div class="statistics-actions">
            <el-button
              type="primary"
              :loading="statisticsLoading"
              :disabled="!buildResult.valid"
              @click="runStatistics"
            >
              执行统计
            </el-button>
            <span v-if="!buildResult.valid" class="validation-error">
              {{ buildResult.message }}
            </span>
          </div>
        </template>
      </template>
    </el-card>

    <StatisticsResultPanel
      v-if="selectedTable"
      :result="result"
      :error="statisticsError"
      :loading="statisticsLoading"
      :measure-label="measureLabel"
      :measure-fn="draft.fn"
      :selected-dimension-field="selectedDimensionField"
    />

    <el-card v-else-if="!tablesLoading" shadow="never" class="empty-selection">
      <el-empty description="请先在页面顶部选择一张数据采集表" />
    </el-card>
  </section>
</template>

<style scoped src="./statistics-view.css"></style>
