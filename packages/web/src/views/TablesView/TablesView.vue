<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import {
  listTables,
  TABLE_STATUSES,
  type CollectionTable,
  type TableStatus,
} from '../../api/tables.js';
import { getApiErrorMessage } from '../../api/errors.js';
import { can } from '../../permissions.js';
import { useAuthStore } from '../../stores/auth.js';
import { useTimezoneStore } from '../../stores/timezone.js';
import {
  filterAndSortTables,
  getTableStatusLabel,
  TABLE_STATUS_TAG_TYPES,
  type TableSort,
} from './tables.logic.js';
import TablesCreateDialog from './TablesCreateDialog.vue';

const SORT_OPTIONS: readonly { value: TableSort; label: string }[] = [
  { value: 'createdAtDesc', label: '创建时间：从新到旧' },
  { value: 'createdAtAsc', label: '创建时间：从旧到新' },
  { value: 'displayNameAsc', label: '名称：升序' },
  { value: 'displayNameDesc', label: '名称：降序' },
];

const router = useRouter();
const authStore = useAuthStore();
const timezoneStore = useTimezoneStore();
const tables = ref<CollectionTable[]>([]);
const tablesLoading = ref(false);
const tablesError = ref('');
const search = ref('');
const statusFilter = ref<TableStatus | 'all'>('all');
const sort = ref<TableSort>('createdAtDesc');

const createDialogVisible = ref(false);

const role = computed(() => authStore.user?.role);
const canViewTables = computed(() => role.value !== undefined && can(role.value, 'viewTables'));
const canCreateTable = computed(() => role.value !== undefined && can(role.value, 'createTable'));
const canReadTemplates = computed(
  () => role.value !== undefined && can(role.value, 'readTableTemplates'),
);
const visibleTables = computed(() =>
  filterAndSortTables(tables.value, search.value, statusFilter.value, sort.value),
);

function getStatusTagType(status: TableStatus): (typeof TABLE_STATUS_TAG_TYPES)[TableStatus] {
  return TABLE_STATUS_TAG_TYPES[status];
}

async function loadTables(): Promise<void> {
  if (!canViewTables.value) {
    return;
  }
  tablesLoading.value = true;
  tablesError.value = '';
  try {
    const response = await listTables();
    tables.value = response.tables;
  } catch (error) {
    tablesError.value = getApiErrorMessage(error);
  } finally {
    tablesLoading.value = false;
  }
}

function openCreateDialog(): void {
  createDialogVisible.value = true;
}

function closeCreateDialog(): void {
  createDialogVisible.value = false;
}

function openTable(projectId: string): void {
  void router.push({ name: 'table-detail', params: { projectId } });
}

onMounted(() => {
  void loadTables();
});
</script>

<template>
  <section class="tables-page">
    <div class="page-actions">
      <div>
        <p class="section-eyebrow">COLLECTION TABLES</p>
        <h2>数据采集表</h2>
        <p>管理前端上报项目及其 Schema 配置。</p>
      </div>
      <el-button v-if="canCreateTable" type="primary" size="large" @click="openCreateDialog">
        创建数据采集表
      </el-button>
    </div>

    <el-card class="table-card" shadow="never">
      <div class="toolbar">
        <el-input
          v-model="search"
          class="search-input"
          clearable
          placeholder="搜索名称、Project ID、说明或创建人"
          aria-label="搜索数据采集表"
        />
        <el-select v-model="statusFilter" class="status-filter" aria-label="按状态筛选">
          <el-option label="全部状态" value="all" />
          <el-option
            v-for="status in TABLE_STATUSES"
            :key="status"
            :label="getTableStatusLabel(status)"
            :value="status"
          />
        </el-select>
        <el-select v-model="sort" class="sort-select" aria-label="列表排序">
          <el-option
            v-for="option in SORT_OPTIONS"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
        <el-button :loading="tablesLoading" @click="loadTables">刷新</el-button>
      </div>

      <el-alert
        v-if="tablesError"
        class="tables-error"
        :title="tablesError"
        type="error"
        :closable="false"
        show-icon
      >
        <template #default>
          <el-button link type="primary" @click="loadTables">重新加载</el-button>
        </template>
      </el-alert>

      <el-table v-loading="tablesLoading" :data="visibleTables" row-key="projectId">
        <el-table-column label="数据采集表" min-width="220">
          <template #default="scope">
            <button class="table-name-link" type="button" @click="openTable(scope.row.projectId)">
              {{ scope.row.displayName }}
            </button>
            <p class="table-description">{{ scope.row.description || '暂无说明' }}</p>
          </template>
        </el-table-column>
        <el-table-column label="Project ID" min-width="250">
          <template #default="scope">
            <code class="project-id">{{ scope.row.projectId }}</code>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="scope">
            <el-tag :type="getStatusTagType(scope.row.status)" effect="light" round>
              {{ getTableStatusLabel(scope.row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="schemaVersion" label="Schema 版本" width="120" align="center" />
        <el-table-column prop="createdBy" label="创建人" min-width="130" />
        <el-table-column label="创建时间" min-width="180">
          <template #default="scope">
            {{ timezoneStore.formatUtc(scope.row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right" align="right">
          <template #default="scope">
            <el-button link type="primary" @click="openTable(scope.row.projectId)"
              >查看详情</el-button
            >
          </template>
        </el-table-column>
        <template #empty>
          <el-empty
            :description="tables.length === 0 ? '暂无数据采集表' : '没有符合条件的数据采集表'"
          />
        </template>
      </el-table>

      <div class="table-summary">
        共 {{ visibleTables.length }} 张<span v-if="visibleTables.length !== tables.length"
          >，全部 {{ tables.length }} 张</span
        >
      </div>
    </el-card>
  </section>

  <TablesCreateDialog
    v-if="createDialogVisible"
    :can-read-templates="canReadTemplates"
    @close="closeCreateDialog"
    @reload="loadTables"
  />
</template>

<style scoped src="./tables-view.css"></style>
