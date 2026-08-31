<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { getApiErrorMessage } from '../../api/errors.js';
import { queryTableRows, type DetailRow } from '../../api/query.js';
import {
  retryTable,
  setTableStatus,
  type CollectionField,
  type CollectionTable,
} from '../../api/tables.js';
import { formatCellValue, getCellKind, getColumnLabel, getColumnWidth } from '../../detail-rows.js';
import { can } from '../../permissions.js';
import { useAuthStore } from '../../stores/auth.js';
import { useTimezoneStore } from '../../stores/timezone.js';
import { TABLE_STATUS_TAG_TYPES, getTableStatusLabel } from '../TablesView/tables.logic.js';
import { useTableDetailDelete } from './table-detail-delete.js';
import {
  buildRecentReportQuery,
  canDeleteTable,
  canLoadRecentReports,
  countPhysicalFields,
  getTableStatusActions,
  type TableStatusAction,
} from './table-detail.logic.js';
import VDialog from '../../components/v-dialog.vue';

type RecentReportState = 'idle' | 'loading' | 'ready' | 'error' | 'not_ready';

const props = defineProps<{
  projectId: string;
  table: CollectionTable;
  fields: CollectionField[];
  applyTable: (table: CollectionTable) => void;
  loadDetail: () => Promise<void>;
}>();

const router = useRouter();
const authStore = useAuthStore();
const timezoneStore = useTimezoneStore();
const projectId = computed(() => props.projectId);
const tableRef = computed<CollectionTable | null>({
  get: () => props.table,
  set: () => undefined,
});
const role = computed(() => authStore.user?.role);
const canChangeStatus = computed(
  () => role.value !== undefined && can(role.value, 'changeTableStatus'),
);
const canQueryData = computed(() => role.value !== undefined && can(role.value, 'queryData'));
const canRenderDeleteTable = computed(
  () => role.value !== undefined && can(role.value, 'deleteTable'),
);
const availableStatusActions = computed(() =>
  canChangeStatus.value ? getTableStatusActions(props.table.status) : [],
);
const retryAvailable = computed(() => canChangeStatus.value && props.table.status === 'failed');
const tableDeletionAllowed = computed(() => canDeleteTable(role.value, props.table.status));
const physicalFieldCount = computed(() => countPhysicalFields(props.fields));
const statusSubmitting = ref(false);
const recentReportState = ref<RecentReportState>('idle');
const recentRows = ref<DetailRow[]>([]);
const recentReportError = ref('');
const recentColumns = computed(() =>
  recentRows.value[0] === undefined ? [] : Object.keys(recentRows.value[0]),
);
const formatUtc = (value: string): string => timezoneStore.formatUtc(value);

async function copyText(value: string, successMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    ElMessage.success(successMessage);
  } catch {
    ElMessage.error('复制失败，请手动选择并复制');
  }
}

async function loadRecentReports(status = props.table.status): Promise<void> {
  recentRows.value = [];
  recentReportError.value = '';
  if (!canLoadRecentReports(status)) {
    recentReportState.value = 'not_ready';
    return;
  }
  recentReportState.value = 'loading';
  try {
    const response = await queryTableRows(props.projectId, buildRecentReportQuery());
    recentRows.value = response.rows;
    recentReportState.value = 'ready';
  } catch (error) {
    recentReportError.value = getApiErrorMessage(error);
    recentReportState.value = 'error';
  }
}

async function confirmStatusAction(action: TableStatusAction): Promise<boolean> {
  if (!action.requiresConfirmation) {
    return true;
  }
  const isDisable = action.target === 'disabled';
  try {
    await ElMessageBox.confirm(
      isDisable
        ? '停用后该表的上报会被拒（TABLE_DISABLED），查询不受影响。'
        : '归档同样停止上报，但归档可逆，可以再改回启用。',
      isDisable ? '确认停用数据采集表？' : '确认归档数据采集表？',
      {
        type: 'warning',
        confirmButtonText: isDisable ? '确认停用' : '确认归档',
        cancelButtonText: '取消',
      },
    );
    return true;
  } catch {
    return false;
  }
}

async function changeStatus(action: TableStatusAction): Promise<void> {
  if (!(await confirmStatusAction(action))) {
    return;
  }
  statusSubmitting.value = true;
  try {
    const response = await setTableStatus(props.projectId, action.target);
    props.applyTable(response.table);
    ElMessage.success(`状态已更新为${getTableStatusLabel(response.table.status)}`);
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    statusSubmitting.value = false;
  }
}

async function handleRetry(): Promise<void> {
  statusSubmitting.value = true;
  try {
    const response = await retryTable(props.projectId);
    props.applyTable(response.table);
    ElMessage.success('重试成功，数据采集表已启用');
    void loadRecentReports(response.table.status);
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
    await props.loadDetail();
  } finally {
    statusSubmitting.value = false;
  }
}

function openQuery(): void {
  void router.push({ name: 'query', query: { projectId: props.projectId } });
}

const {
  continueTableDelete,
  loadTableRowCount,
  openTableDelete,
  submitTableDelete,
  tableDeleteConfirmation,
  tableDeleteConfirmed,
  tableDeleteFirstVisible,
  tableDeleteSecondVisible,
  tableDeleteSubmitting,
  tableRowCount,
  tableRowCountError,
  tableRowCountState,
} = useTableDetailDelete({
  projectId,
  table: tableRef,
  tableDeletionAllowed,
  loadDetail: props.loadDetail,
  router,
});

onMounted(() => {
  void loadRecentReports();
});
</script>

<template>
  <section class="tab-section">
    <el-descriptions :column="2" border>
      <el-descriptions-item label="表名称">{{ table.displayName }}</el-descriptions-item>
      <el-descriptions-item label="状态">
        <el-tag :type="TABLE_STATUS_TAG_TYPES[table.status]" effect="light">
          {{ getTableStatusLabel(table.status) }}
        </el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="Project ID" :span="2">
        <div class="copy-value">
          <code>{{ table.projectId }}</code>
          <el-button link type="primary" @click="copyText(table.projectId, 'Project ID 已复制')"
            >复制</el-button
          >
        </div>
      </el-descriptions-item>
      <el-descriptions-item label="说明" :span="2">
        {{ table.description || '暂无说明' }}
      </el-descriptions-item>
      <el-descriptions-item label="Schema 版本">
        {{ table.schemaVersion }}
      </el-descriptions-item>
      <el-descriptions-item label="创建人">{{ table.createdBy }}</el-descriptions-item>
      <el-descriptions-item label="创建时间">
        {{ timezoneStore.formatUtc(table.createdAt) }}
      </el-descriptions-item>
      <el-descriptions-item label="更新时间">
        {{ timezoneStore.formatUtc(table.updatedAt) }}
      </el-descriptions-item>
    </el-descriptions>

    <section class="status-panel">
      <div>
        <h3>状态迁移</h3>
        <p v-if="!canChangeStatus">当前角色只能查看状态。</p>
        <p v-else-if="table.status === 'creating'">
          创建中状态由服务端 reconcile 收敛，当前没有手动迁移入口。
        </p>
        <p v-else>只展示当前状态允许执行的迁移。</p>
      </div>
      <div v-if="canChangeStatus" class="status-actions">
        <el-button
          v-for="action in availableStatusActions"
          :key="action.target"
          :type="action.target === 'archived' ? 'warning' : 'primary'"
          plain
          :loading="statusSubmitting"
          @click="changeStatus(action)"
        >
          {{ action.label }}
        </el-button>
        <el-button
          v-if="retryAvailable"
          type="primary"
          :loading="statusSubmitting"
          @click="handleRetry"
        >
          重试创建
        </el-button>
      </div>
    </section>

    <section class="recent-panel">
      <header class="recent-heading">
        <div>
          <h3>最近上报记录</h3>
          <p>最近 7 天 · 最新优先 · 最多 20 条</p>
        </div>
        <el-button v-if="canQueryData" type="primary" plain @click="openQuery">
          打开数据明细查询
        </el-button>
      </header>

      <el-alert
        v-if="recentReportState === 'not_ready'"
        title="数据采集表尚未就绪，暂不查询最近记录"
        type="info"
        :closable="false"
        show-icon
      />
      <el-skeleton v-else-if="recentReportState === 'loading'" :rows="4" animated />
      <el-alert
        v-else-if="recentReportState === 'error'"
        :title="recentReportError"
        type="error"
        :closable="false"
        show-icon
      >
        <template #default>
          <el-button link type="primary" @click="loadRecentReports()">重新加载</el-button>
        </template>
      </el-alert>
      <el-empty
        v-else-if="recentReportState === 'ready' && recentRows.length === 0"
        description="最近 7 天无上报记录"
      />
      <el-table
        v-else-if="recentRows.length > 0"
        :data="recentRows"
        row-key="_record_id"
        max-height="430"
        class="recent-table"
      >
        <el-table-column
          v-for="column in recentColumns"
          :key="column"
          :prop="column"
          :label="getColumnLabel(column, fields)"
          :min-width="getColumnWidth(column)"
          show-overflow-tooltip
        >
          <template #header>
            <div class="recent-column-heading">
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
            <span v-else-if="getCellKind(scope.row[column]) === 'unset'" class="recent-unset">
              未提交
            </span>
            <span
              v-else
              :class="{
                'recent-empty-string': getCellKind(scope.row[column]) === 'empty-string',
              }"
            >
              {{ formatCellValue(scope.row[column], column, formatUtc) }}
            </span>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section v-if="canRenderDeleteTable" class="danger-zone">
      <div>
        <h3>危险操作</h3>
        <p>永久删除整张数据采集表、全部历史数据和字段墓碑。</p>
      </div>
      <el-tooltip content="请先归档" placement="top" :disabled="tableDeletionAllowed">
        <span>
          <el-button type="danger" :disabled="!tableDeletionAllowed" @click="openTableDelete">
            永久删除本表
          </el-button>
        </span>
      </el-tooltip>
    </section>
  </section>

  <v-dialog v-if="tableDeleteFirstVisible" width="660px" @close="tableDeleteFirstVisible = false">
    <template #header>永久删除数据采集表</template>
    <template #body>
      <el-alert
        title="这是系统中爆炸半径最大的单个操作，请逐项核对。"
        type="error"
        :closable="false"
        show-icon
      />
      <el-descriptions :column="1" border class="confirmation-details">
        <el-descriptions-item label="表名称">{{ table.displayName }}</el-descriptions-item>
        <el-descriptions-item label="Project ID">{{ table.projectId }}</el-descriptions-item>
        <el-descriptions-item label="字段数">{{ physicalFieldCount }}</el-descriptions-item>
        <el-descriptions-item label="当前总行数（可能略高估）">
          <span v-if="tableRowCountState === 'loading'">查询中…</span>
          <span v-else-if="tableRowCountState === 'ready'">
            {{ tableRowCount.toLocaleString('zh-CN') }}
          </span>
          <span v-else-if="tableRowCountState === 'error'" class="count-error">
            行数获取失败：{{ tableRowCountError }}
            <el-button link type="primary" @click="loadTableRowCount">重试</el-button>
          </span>
        </el-descriptions-item>
        <el-descriptions-item label="创建时间">
          {{ timezoneStore.formatUtc(table.createdAt) }}
        </el-descriptions-item>
        <el-descriptions-item label="创建人">{{ table.createdBy }}</el-descriptions-item>
      </el-descriptions>
      <ul class="consequences">
        <li>历史数据永久销毁且无法恢复；</li>
        <li>该 projectId 立即失效，仍在使用它的前端埋点会开始收到错误；</li>
        <li>该表的字段 Key 墓碑一并清除。</li>
      </ul>
      <p class="count-note">
        总行数统计的是未 merge 的物理行数，同一 recordId 的重试可能造成略高估，仅供评估影响范围。
      </p>
    </template>
    <el-button @click="tableDeleteFirstVisible = false">取消</el-button>
    <el-button type="danger" @click="continueTableDelete">我了解后果，继续</el-button>
  </v-dialog>

  <v-dialog
    v-if="tableDeleteSecondVisible"
    width="540px"
    :loading="tableDeleteSubmitting"
    :show-close="!tableDeleteSubmitting"
    @close="tableDeleteSecondVisible = false"
  >
    <template #header>二次确认：输入表名称</template>
    <template #body>
      <p>
        请手动输入 <strong>{{ table.displayName }}</strong
        >（不是 Project ID），完全一致后才能永久删除。
      </p>
      <el-input
        v-model="tableDeleteConfirmation"
        :placeholder="table.displayName"
        autocomplete="off"
      />
    </template>
    <el-button :disabled="tableDeleteSubmitting" @click="tableDeleteSecondVisible = false">
      取消
    </el-button>
    <el-button
      type="danger"
      :loading="tableDeleteSubmitting"
      :disabled="!tableDeleteConfirmed"
      @click="submitTableDelete"
    >
      永久删除数据采集表
    </el-button>
  </v-dialog>
</template>

<style scoped src="./table-detail-view.css"></style>
