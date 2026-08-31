<script setup lang="ts">
import { computed, watch } from 'vue';

import type { CollectionField, CollectionTable } from '../../api/tables.js';
import { ElMessage } from 'element-plus';
import { useTableDetailSecret } from './table-detail-secret.js';
import { INGEST_CONTENT_TYPE_NOTICE, LOG_CLIENT_CODE } from './table-detail.logic.js';

const props = defineProps<{
  active: boolean;
  projectId: string;
  table: CollectionTable;
  fields: CollectionField[];
  canManageSecret: boolean;
}>();

const projectId = computed(() => props.projectId);
const table = computed<CollectionTable | null>({
  get: () => props.table,
  set: () => undefined,
});
const fields = computed<CollectionField[]>({
  get: () => props.fields,
  set: () => undefined,
});
const canManageSecret = computed(() => props.canManageSecret);
const {
  displayedSecret,
  handleTabChange,
  integrationUsageCode,
  loadSecret,
  rotateSecret,
  secret,
  secretError,
  secretLoading,
  secretVisible,
} = useTableDetailSecret({ projectId, table, fields, canManageSecret });

async function copyText(value: string, successMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    ElMessage.success(successMessage);
  } catch {
    ElMessage.error('复制失败，请手动选择并复制');
  }
}

watch(
  () => props.active,
  (active) => {
    if (active) {
      handleTabChange('integration');
    }
  },
  { immediate: true },
);
</script>

<template>
  <section class="tab-section integration-section">
    <el-card shadow="never" class="secret-card">
      <template #header>
        <div class="card-heading">
          <div>
            <h3>上报密钥</h3>
            <p>明文密钥仅从当前接口读取，请按敏感凭据保管。</p>
          </div>
          <el-button :loading="secretLoading" @click="rotateSecret">轮换密钥</el-button>
        </div>
      </template>
      <el-skeleton v-if="secretLoading && secret === ''" :rows="2" animated />
      <el-alert
        v-else-if="secretError"
        :title="secretError"
        type="error"
        :closable="false"
        show-icon
      >
        <template #default>
          <el-button link type="primary" @click="loadSecret(true)">重试</el-button>
        </template>
      </el-alert>
      <div v-else class="secret-value">
        <code>{{ displayedSecret }}</code>
        <el-button link type="primary" @click="secretVisible = !secretVisible">
          {{ secretVisible ? '隐藏' : '显示' }}
        </el-button>
        <el-button
          link
          type="primary"
          :disabled="secret === ''"
          @click="copyText(secret, '上报密钥已复制')"
        >
          复制
        </el-button>
      </div>
    </el-card>

    <template v-if="secret !== ''">
      <section class="code-section">
        <div class="code-heading">
          <div>
            <h3>log-client.ts</h3>
            <p>按 8.1.3 提供的完整 TypeScript 上报客户端。</p>
          </div>
          <el-button @click="copyText(LOG_CLIENT_CODE, 'log-client.ts 已复制')">
            复制代码
          </el-button>
        </div>
        <pre><code>{{ LOG_CLIENT_CODE }}</code></pre>
      </section>

      <section class="code-section">
        <div class="code-heading">
          <div>
            <h3>使用</h3>
            <p>示例数据只使用当前 active 字段；显示密钥后才会填入明文。</p>
          </div>
          <el-button
            :disabled="!secretVisible"
            @click="copyText(integrationUsageCode, '使用示例已复制')"
          >
            复制代码
          </el-button>
        </div>
        <pre><code>{{ integrationUsageCode }}</code></pre>
      </section>

      <el-alert :title="INGEST_CONTENT_TYPE_NOTICE" type="warning" :closable="false" show-icon />
    </template>
  </section>
</template>

<style scoped src="./table-detail-view.css"></style>
