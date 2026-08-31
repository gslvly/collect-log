<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError, getApiErrorMessage } from '../../api/errors.js';
import { getTableDetail, type CollectionField, type CollectionTable } from '../../api/tables.js';
import { can } from '../../permissions.js';
import { useAuthStore } from '../../stores/auth.js';
import { TABLE_STATUS_TAG_TYPES, getTableStatusLabel } from '../TablesView/tables.logic.js';
import TableDetailFieldsTab from './TableDetailFieldsTab.vue';
import TableDetailInfoTab from './TableDetailInfoTab.vue';
import TableDetailIntegrationTab from './TableDetailIntegrationTab.vue';

type DetailTab = 'info' | 'fields' | 'integration';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const projectId = computed(() => String(route.params.projectId ?? ''));
const role = computed(() => authStore.user?.role);

const table = ref<CollectionTable | null>(null);
const fields = ref<CollectionField[]>([]);
const loading = ref(false);
const loadError = ref('');
const tableNotFound = ref(false);
const activeTab = ref<DetailTab>('info');

const canQueryData = computed(() => role.value !== undefined && can(role.value, 'queryData'));
const canManageSecret = computed(
  () => role.value !== undefined && can(role.value, 'manageIngestSecret'),
);

function applyTable(next: CollectionTable): void {
  table.value = next;
}

async function loadDetail(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  tableNotFound.value = false;
  try {
    const response = await getTableDetail(projectId.value);
    table.value = response.table;
    fields.value = response.fields;
  } catch (error) {
    table.value = null;
    fields.value = [];
    if (error instanceof ApiError && error.code === 'TABLE_NOT_FOUND') {
      tableNotFound.value = true;
    } else {
      loadError.value = getApiErrorMessage(error);
    }
  } finally {
    loading.value = false;
  }
}

function openStatistics(): void {
  // 10.3 的「统计分析入口」：带上当前表，落地即可直接选轴。
  void router.push({ name: 'statistics', query: { projectId: projectId.value } });
}

onMounted(() => {
  void loadDetail();
});
</script>

<template>
  <section class="detail-page">
    <el-button link type="primary" @click="router.push('/tables')">← 返回数据采集表</el-button>

    <el-card v-if="loading && table === null" shadow="never" class="state-card">
      <el-skeleton :rows="8" animated />
    </el-card>

    <el-card v-else-if="tableNotFound" shadow="never" class="state-card">
      <el-empty description="数据采集表不存在或已被删除">
        <el-button type="primary" @click="router.push('/tables')">返回列表</el-button>
      </el-empty>
    </el-card>

    <el-alert v-else-if="loadError" :title="loadError" type="error" :closable="false" show-icon>
      <template #default>
        <el-button link type="primary" @click="loadDetail">重新加载</el-button>
      </template>
    </el-alert>

    <template v-else-if="table">
      <header class="detail-heading">
        <div>
          <p class="section-eyebrow">COLLECTION TABLE DETAIL</p>
          <div class="title-row">
            <h2>{{ table.displayName }}</h2>
            <el-tag :type="TABLE_STATUS_TAG_TYPES[table.status]" effect="light" round>
              {{ getTableStatusLabel(table.status) }}
            </el-tag>
          </div>
          <p>{{ table.description || '暂无说明' }}</p>
        </div>
        <el-button v-if="canQueryData" @click="openStatistics">统计分析</el-button>
      </header>

      <el-card shadow="never" class="detail-card">
        <el-tabs v-model="activeTab">
          <el-tab-pane label="基本信息与状态" name="info">
            <TableDetailInfoTab
              :project-id="projectId"
              :table="table"
              :fields="fields"
              :apply-table="applyTable"
              :load-detail="loadDetail"
            />
          </el-tab-pane>

          <el-tab-pane label="字段配置" name="fields">
            <TableDetailFieldsTab
              :project-id="projectId"
              :table="table"
              :fields="fields"
              :apply-table="applyTable"
              :load-detail="loadDetail"
            />
          </el-tab-pane>

          <el-tab-pane v-if="canManageSecret" label="接入文档" name="integration">
            <TableDetailIntegrationTab
              :active="activeTab === 'integration'"
              :project-id="projectId"
              :table="table"
              :fields="fields"
              :can-manage-secret="canManageSecret"
            />
          </el-tab-pane>
        </el-tabs>
      </el-card>
    </template>
  </section>
</template>

<style scoped src="./table-detail-view.css"></style>
