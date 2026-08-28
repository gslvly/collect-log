<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import {
  createTable,
  FIELD_TYPES,
  getTableTemplate,
  listTables,
  listTableTemplates,
  TABLE_STATUSES,
  type CollectionTable,
  type CreateFieldInput,
  type FieldType,
  type TableStatus,
  type TableTemplateSummary,
} from '../api/tables.js';
import { getApiErrorMessage } from '../api/errors.js';
import { can } from '../permissions.js';
import { useAuthStore } from '../stores/auth.js';
import { useTimezoneStore } from '../stores/timezone.js';
import {
  applyTableTemplate,
  filterAndSortTables,
  getTableStatusLabel,
  hasTemplateContentToOverwrite,
  toCreateTableInput,
  validateCreateTableForm,
  type CreateTableFormValue,
  type TableSort,
} from './tables.logic.js';

interface EditableField extends CreateFieldInput {
  rowId: number;
}

interface EditableCreateTableForm {
  displayName: string;
  description: string;
  fields: EditableField[];
}

const STATUS_TAG_TYPES = {
  creating: 'warning',
  active: 'success',
  disabled: 'info',
  archived: 'info',
  failed: 'danger',
} as const satisfies Record<TableStatus, 'warning' | 'success' | 'info' | 'danger'>;

const FIELD_TYPE_LABELS = {
  string: '字符串',
  boolean: '布尔值',
} as const satisfies Record<FieldType, string>;

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
const createSubmitting = ref(false);
const validationAttempted = ref(false);
const templates = ref<TableTemplateSummary[]>([]);
const templatesLoading = ref(false);
const templateApplying = ref(false);
const templatesError = ref('');
const selectedTemplateId = ref('');
const templateNotice = ref('');
let nextRowId = 1;

const form = reactive<EditableCreateTableForm>({
  displayName: '',
  description: '',
  fields: [],
});

const role = computed(() => authStore.user?.role);
const canViewTables = computed(() => role.value !== undefined && can(role.value, 'viewTables'));
const canCreateTable = computed(() => role.value !== undefined && can(role.value, 'createTable'));
const canReadTemplates = computed(
  () => role.value !== undefined && can(role.value, 'readTableTemplates'),
);
const visibleTables = computed(() =>
  filterAndSortTables(tables.value, search.value, statusFilter.value, sort.value),
);
const createFormValue = computed<CreateTableFormValue>(() => ({
  displayName: form.displayName,
  description: form.description,
  fields: form.fields,
}));
const validation = computed(() => validateCreateTableForm(createFormValue.value));

function getStatusTagType(status: TableStatus): (typeof STATUS_TAG_TYPES)[TableStatus] {
  return STATUS_TAG_TYPES[status];
}

function makeEditableField(field?: CreateFieldInput): EditableField {
  return {
    rowId: nextRowId++,
    key: field?.key ?? '',
    label: field?.label ?? '',
    type: field?.type ?? 'string',
    required: field?.required ?? false,
    description: field?.description ?? '',
  };
}

function resetCreateForm(): void {
  form.displayName = '';
  form.description = '';
  form.fields = [];
  selectedTemplateId.value = '';
  templateNotice.value = '';
  templatesError.value = '';
  validationAttempted.value = false;
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

async function loadTemplates(): Promise<void> {
  if (!canReadTemplates.value) {
    return;
  }
  templatesLoading.value = true;
  templatesError.value = '';
  try {
    const response = await listTableTemplates();
    templates.value = response.templates;
  } catch (error) {
    templatesError.value = getApiErrorMessage(error);
  } finally {
    templatesLoading.value = false;
  }
}

function openCreateDialog(): void {
  resetCreateForm();
  templates.value = [];
  createDialogVisible.value = true;
  if (canReadTemplates.value) {
    void loadTemplates();
  }
}

function addField(): void {
  form.fields.push(makeEditableField());
}

function removeField(index: number): void {
  form.fields.splice(index, 1);
}

async function confirmTemplateOverwrite(): Promise<boolean> {
  if (!hasTemplateContentToOverwrite(createFormValue.value)) {
    return true;
  }
  try {
    await ElMessageBox.confirm(
      '选择模板会覆盖当前字段列表及表说明，已编辑的字段内容将丢失。',
      '确认覆盖字段？',
      {
        type: 'warning',
        confirmButtonText: '确认覆盖',
        cancelButtonText: '取消',
      },
    );
    return true;
  } catch {
    return false;
  }
}

async function handleTemplateChange(projectId: string): Promise<void> {
  if (projectId === '') {
    selectedTemplateId.value = '';
    return;
  }
  if (!(await confirmTemplateOverwrite())) {
    return;
  }

  templateApplying.value = true;
  try {
    const template = await getTableTemplate(projectId);
    const mapped = applyTableTemplate(createFormValue.value, template);
    form.description = mapped.description;
    form.fields = mapped.fields.map((field) => makeEditableField(field));
    selectedTemplateId.value = projectId;
    templateNotice.value = `已从《${template.sourceDisplayName}》复制 ${template.fields.length} 个字段`;
    validationAttempted.value = false;
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    templateApplying.value = false;
  }
}

async function submitCreateTable(): Promise<void> {
  validationAttempted.value = true;
  if (!validation.value.valid) {
    return;
  }

  createSubmitting.value = true;
  try {
    await createTable(toCreateTableInput(createFormValue.value));
    ElMessage.success('数据采集表创建成功');
    createDialogVisible.value = false;
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    await loadTables();
    createSubmitting.value = false;
  }
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

  <el-dialog
    v-model="createDialogVisible"
    class="create-table-dialog"
    title="创建数据采集表"
    width="min(960px, calc(100vw - 32px))"
    destroy-on-close
    :close-on-click-modal="!createSubmitting"
    :close-on-press-escape="!createSubmitting"
    @closed="resetCreateForm"
  >
    <el-form label-position="top" @submit.prevent="submitCreateTable">
      <div class="basic-fields">
        <el-form-item
          label="表名称"
          required
          :error="validationAttempted ? validation.displayName : undefined"
        >
          <el-input v-model="form.displayName" placeholder="请输入易于识别的数据采集表名称" />
        </el-form-item>
        <el-form-item label="表说明">
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="3"
            placeholder="说明采集场景或数据用途（选填）"
          />
        </el-form-item>
      </div>

      <section v-if="canReadTemplates" class="template-panel">
        <div class="template-copy">
          <strong>从现有表复制字段</strong>
          <span>可选；会回填表说明和字段，表名称仍需单独填写。</span>
        </div>
        <div class="template-control">
          <el-select
            :model-value="selectedTemplateId"
            class="template-select"
            clearable
            filterable
            :loading="templatesLoading || templateApplying"
            :disabled="templateApplying"
            placeholder="选择一张来源表"
            @change="handleTemplateChange"
          >
            <el-option
              v-for="template in templates"
              :key="template.projectId"
              :label="`${template.displayName} · ${getTableStatusLabel(template.status)} · ${template.fieldCount} 个字段`"
              :value="template.projectId"
            >
              <div class="template-option">
                <span>{{ template.displayName }}</span>
                <small
                  >{{ getTableStatusLabel(template.status) }} ·
                  {{ template.fieldCount }} 个字段</small
                >
              </div>
            </el-option>
          </el-select>
          <el-button v-if="templatesError" link type="primary" @click="loadTemplates"
            >重试</el-button
          >
        </div>
        <p v-if="templatesError" class="template-error">{{ templatesError }}</p>
        <el-alert
          v-if="templateNotice"
          class="template-notice"
          :title="templateNotice"
          type="success"
          :closable="false"
          show-icon
        />
      </section>

      <section class="fields-section">
        <div class="fields-heading">
          <div>
            <h3>字段定义</h3>
            <p>字段可在创建前自由调整；数量限制由服务端校验。</p>
          </div>
          <el-button @click="addField">添加字段</el-button>
        </div>

        <el-empty
          v-if="form.fields.length === 0"
          description="暂未添加字段，可直接创建空表或添加字段"
        />

        <div v-else class="field-list">
          <article v-for="(field, index) in form.fields" :key="field.rowId" class="field-card">
            <div class="field-card-heading">
              <strong>字段 {{ index + 1 }}</strong>
              <el-button link type="danger" @click="removeField(index)">移除</el-button>
            </div>
            <div class="field-grid">
              <el-form-item
                label="字段 Key"
                required
                :error="validationAttempted ? validation.fields[index]?.key : undefined"
              >
                <el-input v-model="field.key" placeholder="例如 event_name" />
              </el-form-item>
              <el-form-item
                label="字段名称"
                required
                :error="validationAttempted ? validation.fields[index]?.label : undefined"
              >
                <el-input v-model="field.label" placeholder="例如 事件名" />
              </el-form-item>
              <el-form-item label="字段类型">
                <el-select v-model="field.type">
                  <el-option
                    v-for="fieldType in FIELD_TYPES"
                    :key="fieldType"
                    :label="FIELD_TYPE_LABELS[fieldType]"
                    :value="fieldType"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="必填">
                <el-switch
                  v-model="field.required"
                  inline-prompt
                  active-text="是"
                  inactive-text="否"
                />
              </el-form-item>
              <el-form-item class="field-description-input" label="字段说明">
                <el-input v-model="field.description" placeholder="说明字段含义（选填）" />
              </el-form-item>
            </div>
          </article>
        </div>
      </section>
    </el-form>

    <template #footer>
      <el-button :disabled="createSubmitting" @click="createDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="createSubmitting" @click="submitCreateTable">
        创建
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.tables-page {
  display: grid;
  gap: 22px;
}

.page-actions {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
}

.section-eyebrow {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 750;
  letter-spacing: 0.14em;
  color: #2d70d6;
}

.page-actions h2 {
  margin: 0;
  font-size: 26px;
  letter-spacing: -0.02em;
}

.page-actions p:last-child {
  margin: 8px 0 0;
  color: #7d899b;
}

.table-card {
  border-color: #e5ebf3;
  border-radius: 14px;
}

.table-card :deep(.el-card__body) {
  padding: 0;
}

.toolbar {
  display: flex;
  gap: 12px;
  padding: 20px;
  border-bottom: 1px solid #edf1f6;
}

.search-input {
  max-width: 420px;
}

.status-filter {
  width: 150px;
}

.sort-select {
  width: 210px;
}

.tables-error {
  margin: 16px 20px 0;
}

.table-name-link {
  padding: 0;
  cursor: pointer;
  font-weight: 700;
  text-align: left;
  color: #245fac;
  background: transparent;
  border: 0;
}

.table-name-link:hover {
  color: #409eff;
}

.table-description {
  overflow: hidden;
  margin: 5px 0 0;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #8a95a5;
}

.project-id {
  font-size: 12px;
  color: #596579;
  background: #f4f7fb;
}

.table-summary {
  padding: 14px 20px;
  font-size: 13px;
  text-align: right;
  color: #8994a5;
  border-top: 1px solid #edf1f6;
}

.basic-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr);
  gap: 18px;
}

.template-panel {
  padding: 16px;
  margin-bottom: 22px;
  background: #f6f9fe;
  border: 1px solid #e0eafd;
  border-radius: 10px;
}

.template-copy {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
}

.template-copy span {
  font-size: 13px;
  color: #778499;
}

.template-control {
  display: flex;
  align-items: center;
  gap: 10px;
}

.template-select {
  width: min(100%, 560px);
}

.template-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}

.template-option small {
  color: #8792a4;
}

.template-error {
  margin: 8px 0 0;
  font-size: 12px;
  color: #f56c6c;
}

.template-notice {
  margin-top: 12px;
}

.fields-section {
  border-top: 1px solid #edf1f6;
}

.fields-heading,
.field-card-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.fields-heading {
  padding: 20px 0 14px;
}

.fields-heading h3,
.fields-heading p {
  margin: 0;
}

.fields-heading h3 {
  font-size: 17px;
}

.fields-heading p {
  margin-top: 5px;
  font-size: 13px;
  color: #8490a2;
}

.field-list {
  display: grid;
  max-height: 430px;
  padding-right: 4px;
  overflow-y: auto;
  gap: 12px;
}

.field-card {
  padding: 14px 16px 2px;
  background: #fbfcfe;
  border: 1px solid #e5eaf1;
  border-radius: 10px;
}

.field-card-heading {
  margin-bottom: 12px;
}

.field-grid {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(180px, 1fr) 140px 90px;
  gap: 0 12px;
}

.field-description-input {
  grid-column: 1 / -1;
}

@media (max-width: 900px) {
  .toolbar {
    flex-wrap: wrap;
  }

  .search-input {
    width: 100%;
    max-width: none;
  }

  .basic-fields,
  .field-grid {
    grid-template-columns: 1fr 1fr;
  }

  .field-description-input {
    grid-column: 1 / -1;
  }
}

@media (max-width: 620px) {
  .page-actions,
  .template-copy {
    align-items: stretch;
    flex-direction: column;
  }

  .status-filter,
  .sort-select {
    width: 100%;
  }

  .basic-fields,
  .field-grid {
    grid-template-columns: 1fr;
  }

  .field-description-input {
    grid-column: auto;
  }
}
</style>
