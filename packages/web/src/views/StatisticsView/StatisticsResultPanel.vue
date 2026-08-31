<script setup lang="ts">
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { StatisticsResponse } from '../../api/query.js';
import type { CollectionField } from '../../api/tables.js';
import type { FieldMeasure } from '../../api/field-types.js';
import { useTimezoneStore } from '../../stores/timezone.js';
import {
  DENOMINATOR_NOTICE,
  buildChartModel,
  buildChartOption,
  formatMeasureValue,
  formatRowKey,
  formatShare,
  getTruncationNotice,
  needsDenominatorNotice,
} from './statistics.logic.js';

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

const props = defineProps<{
  result: StatisticsResponse | null;
  error: string;
  loading: boolean;
  measureLabel: string;
  measureFn: FieldMeasure;
  selectedDimensionField: CollectionField | undefined;
}>();

const timezoneStore = useTimezoneStore();
const chartHost = ref<HTMLDivElement>();
let chart: echarts.ECharts | null = null;

const denominatorNotice = computed(() =>
  needsDenominatorNotice(props.measureFn) ? DENOMINATOR_NOTICE : '',
);
const truncationNotice = computed(() =>
  props.result === null ? undefined : getTruncationNotice(props.result),
);
const chartModel = computed(() =>
  props.result === null
    ? null
    : buildChartModel(props.result, {
        measureLabel: props.measureLabel,
        ...(props.selectedDimensionField === undefined
          ? {}
          : { field: props.selectedDimensionField }),
        timeZone: timezoneStore.timeZone,
      }),
);

function renderChart(): void {
  const model = chartModel.value;
  if (chartHost.value === undefined || model === null || model.kind === 'none') {
    chart?.dispose();
    chart = null;
    return;
  }
  chart ??= echarts.init(chartHost.value);
  chart.setOption(buildChartOption(model), true);
  chart.resize();
}

function handleResize(): void {
  chart?.resize();
}

watch(chartModel, () => {
  void nextTick(renderChart);
});

onMounted(() => window.addEventListener('resize', handleResize));
onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize);
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <el-card shadow="never" class="result-card">
    <template #header>
      <div class="result-heading">
        <div>
          <h3>统计结果</h3>
          <p v-if="result">
            {{
              result.dimension === null
                ? '不分组'
                : result.dimension === 'time'
                  ? '时间维度'
                  : '字段维度'
            }}
            · {{ measureLabel }}
          </p>
          <p v-else>设置两个轴后执行统计</p>
        </div>
      </div>
    </template>

    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-skeleton v-if="loading && result === null" :rows="6" animated />
    <el-empty v-else-if="result === null" description="尚未执行统计" />

    <template v-else>
      <div class="totals-row">
        <div class="stat-tile">
          <span>总计</span>
          <strong>{{ formatMeasureValue(result.totals.value) }}</strong>
        </div>
        <div class="stat-tile">
          <span>命中行数</span>
          <strong>{{ result.totals.rows.toLocaleString('zh-CN') }}</strong>
        </div>
        <div v-if="result.others" class="stat-tile">
          <span>其它（Top N 之外）</span>
          <strong>{{ formatMeasureValue(result.others.value) }}</strong>
        </div>
        <div v-if="result.nullAxisRows !== undefined" class="stat-tile">
          <span>该业务时间为空而被排除</span>
          <strong>{{ result.nullAxisRows.toLocaleString('zh-CN') }}</strong>
        </div>
      </div>

      <el-alert
        v-if="truncationNotice"
        :title="truncationNotice"
        type="warning"
        :closable="false"
        show-icon
      />
      <p v-if="denominatorNotice" class="denominator-notice">{{ denominatorNotice }}</p>

      <div
        v-show="chartModel && chartModel.kind !== 'none'"
        ref="chartHost"
        class="chart-host"
      ></div>

      <el-table :data="result.rows" class="result-table" max-height="420">
        <el-table-column v-if="result.dimension !== null" label="分组" min-width="220">
          <template #default="scope">
            <span>
              {{
                formatRowKey(scope.row.key, {
                  dimension: result.dimension,
                  field: selectedDimensionField,
                  timeZone: timezoneStore.timeZone,
                })
              }}
            </span>
          </template>
        </el-table-column>
        <el-table-column :label="measureLabel" min-width="160">
          <template #default="scope">{{ formatMeasureValue(scope.row.value) }}</template>
        </el-table-column>
        <el-table-column label="样本行数" min-width="120">
          <template #default="scope">{{ scope.row.rows.toLocaleString('zh-CN') }}</template>
        </el-table-column>
        <el-table-column
          v-if="result.rows.some((row) => row.share !== undefined)"
          label="占比"
          min-width="100"
        >
          <template #default="scope">{{ formatShare(scope.row.share) }}</template>
        </el-table-column>
      </el-table>
    </template>
  </el-card>
</template>

<style scoped src="./statistics-result-panel.css"></style>
