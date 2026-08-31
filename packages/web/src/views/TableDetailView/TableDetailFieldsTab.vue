<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';

import type { CollectionField, CollectionTable, FieldStatus } from '../../api/tables.js';
import { useAuthStore } from '../../stores/auth.js';
import { useTimezoneStore } from '../../stores/timezone.js';
import { can } from '../../permissions.js';
import { useTableDetailDelete } from './table-detail-delete.js';
import { useTableDetailFieldActions } from './table-detail-fields.js';
import {
  FIELD_STATUS_LABELS,
  FIELD_TYPE_LABELS,
  canChangeFieldsInTableStatus,
  getVisibleFields,
  groupFieldsByStatus,
} from './table-detail.logic.js';
import TableDetailFieldDialogs from './TableDetailFieldDialogs.vue';

const FIELD_STATUS_TAG_TYPES = {
  active: 'success',
  deprecated: 'warning',
  dropped: 'danger',
  renamed: 'info',
} as const satisfies Record<FieldStatus, 'success' | 'warning' | 'danger' | 'info'>;

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
const fields = computed<CollectionField[]>({
  get: () => props.fields,
  set: () => undefined,
});
const table = computed<CollectionTable | null>({
  get: () => props.table,
  set: () => undefined,
});
const role = computed(() => authStore.user?.role);
const canManageFields = computed(() => role.value !== undefined && can(role.value, 'manageFields'));
const canDestroyFields = computed(
  () => role.value !== undefined && can(role.value, 'destructiveFieldChanges'),
);
const fieldChangesAllowed = computed(
  () => canManageFields.value && canChangeFieldsInTableStatus(props.table.status),
);
const destructiveFieldChangesAllowed = computed(
  () => canDestroyFields.value && fieldChangesAllowed.value,
);
const showTombstones = ref(false);
const fieldGroups = computed(() => groupFieldsByStatus(props.fields));
const tombstoneCount = computed(
  () => fieldGroups.value.dropped.length + fieldGroups.value.renamed.length,
);
const visibleFields = computed(() => getVisibleFields(props.fields, showTombstones.value));

function getFieldTypeLabel(field: CollectionField): string {
  return FIELD_TYPE_LABELS[field.type];
}

function getFieldStatusLabel(field: CollectionField): string {
  return FIELD_STATUS_LABELS[field.status];
}

function getFieldStatusTagType(
  field: CollectionField,
): (typeof FIELD_STATUS_TAG_TYPES)[FieldStatus] {
  return FIELD_STATUS_TAG_TYPES[field.status];
}

const fieldActions = useTableDetailFieldActions({
  projectId,
  fields,
  applyTable: props.applyTable,
  loadDetail: props.loadDetail,
});
const tableDeletionAllowed = computed(() => false);
const deleteActions = useTableDetailDelete({
  projectId,
  table,
  tableDeletionAllowed,
  loadDetail: props.loadDetail,
  router,
});
const {
  deprecateField,
  openAddDialog,
  openEditDialog,
  openOptionDialog,
  openRenameDialog,
  openRetypeDialog,
} = fieldActions;
const { handleFieldMoreCommand } = deleteActions;
</script>

<template>
  <section class="tab-section">
    <div class="fields-toolbar">
      <div>
        <h3>字段配置</h3>
        <p>文本与枚举可无损互转；其它类型需先物理删除，再新建同名列。</p>
      </div>
      <el-button v-if="fieldChangesAllowed" type="primary" @click="openAddDialog">
        新增字段
      </el-button>
    </div>

    <div class="history-control">
      <el-switch v-model="showTombstones" :disabled="tombstoneCount === 0" />
      <span>显示历史字段（墓碑）</span>
      <small>共 {{ tombstoneCount }} 条</small>
    </div>

    <el-alert
      v-if="canManageFields && !fieldChangesAllowed"
      title="当前表状态不允许字段变更；字段配置仅可查看。"
      type="info"
      :closable="false"
      show-icon
    />

    <el-table :data="visibleFields" row-key="key" class="fields-table">
      <el-table-column prop="key" label="Key" min-width="170">
        <template #default="scope">
          <code>{{ scope.row.key }}</code>
          <p v-if="scope.row.status === 'renamed'" class="renamed-target">
            → {{ scope.row.renamedTo }}
          </p>
        </template>
      </el-table-column>
      <el-table-column prop="label" label="名称" min-width="150" />
      <el-table-column label="类型" min-width="190">
        <template #default="scope">
          <strong>{{ getFieldTypeLabel(scope.row) }}</strong>
          <p v-if="scope.row.type !== 'string' && scope.row.type !== 'enum'" class="type-lock-note">
            不能直接修改类型，请先删除该列，再新建同名列
          </p>
        </template>
      </el-table-column>
      <el-table-column label="必填" width="80" align="center">
        <template #default="scope">{{ scope.row.required ? '是' : '否' }}</template>
      </el-table-column>
      <el-table-column prop="description" label="说明" min-width="180">
        <template #default="scope">{{ scope.row.description || '—' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="120">
        <template #default="scope">
          <el-tag :type="getFieldStatusTagType(scope.row)" effect="light">
            {{ getFieldStatusLabel(scope.row) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="schemaVersion" label="Schema 版本" width="110" align="center" />
      <el-table-column label="更新时间" min-width="180">
        <template #default="scope">
          {{ timezoneStore.formatUtc(scope.row.updatedAt) }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="350" fixed="right" align="right">
        <template #default="scope">
          <template v-if="fieldChangesAllowed && scope.row.status === 'active'">
            <el-button link type="primary" @click="openEditDialog(scope.row)">编辑</el-button>
            <el-button
              v-if="scope.row.type === 'enum'"
              link
              type="primary"
              @click="openOptionDialog(scope.row)"
            >
              编辑选项
            </el-button>
            <el-button
              v-if="scope.row.type === 'string' || scope.row.type === 'enum'"
              link
              type="primary"
              @click="openRetypeDialog(scope.row)"
            >
              {{ scope.row.type === 'string' ? '转换为枚举' : '转换为文本' }}
            </el-button>
            <el-button link type="primary" @click="openRenameDialog(scope.row)"> 重命名 </el-button>
            <el-button link type="warning" @click="deprecateField(scope.row)"> 软废弃 </el-button>
          </template>
          <el-dropdown
            v-if="
              destructiveFieldChangesAllowed &&
              (scope.row.status === 'active' || scope.row.status === 'deprecated')
            "
            trigger="click"
            @command="(command: string) => handleFieldMoreCommand(command, scope.row)"
          >
            <el-button link>更多</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="delete" class="danger-menu-item">
                  物理删除
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <span
            v-if="
              !fieldChangesAllowed ||
              (scope.row.status !== 'active' && scope.row.status !== 'deprecated')
            "
            class="no-action"
            >—</span
          >
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="暂无可显示字段" />
      </template>
    </el-table>
  </section>

  <TableDetailFieldDialogs :field-actions="fieldActions" :delete-actions="deleteActions" />
</template>

<style scoped src="./table-detail-view.css"></style>
