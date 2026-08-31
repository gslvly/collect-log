<script setup lang="ts">
import type { CollectionTable } from '../../api/tables.js';

defineProps<{
  selectedProjectId: string;
  tableOptions: CollectionTable[];
  loading: boolean;
  error: string;
  routeNotice: string;
}>();
const emit = defineEmits<{ change: [value: string]; reload: [] }>();

function handleChange(value: unknown): void {
  emit('change', typeof value === 'string' ? value : '');
}
</script>

<template>
  <header class="query-heading">
    <div>
      <p class="section-eyebrow">DETAIL QUERY</p>
      <h2>按采集表检查原始记录</h2>
      <p>时间、字段与条件共同定义一次查询；修改任一项都会回到第一页。</p>
    </div>
  </header>

  <el-card shadow="never" class="selector-card">
    <div class="selector-row">
      <div>
        <label for="query-table">数据采集表</label>
        <p>创建中和失败的表不会出现在选项中。</p>
      </div>
      <el-select
        id="query-table"
        :model-value="selectedProjectId"
        class="table-selector"
        filterable
        clearable
        :loading="loading"
        placeholder="先选择一张可查询的表"
        @change="handleChange"
      >
        <el-option
          v-for="table in tableOptions"
          :key="table.projectId"
          :value="table.projectId"
          :label="`${table.displayName} · ${table.projectId}`"
        />
      </el-select>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon>
      <template #default>
        <el-button link type="primary" @click="emit('reload')">重新加载</el-button>
      </template>
    </el-alert>
    <el-alert
      v-else-if="routeNotice"
      :title="routeNotice"
      type="warning"
      :closable="false"
      show-icon
    />
  </el-card>
</template>

<style scoped src="./query-table-selector.css"></style>
