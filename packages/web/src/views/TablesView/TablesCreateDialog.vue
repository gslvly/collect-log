<script setup lang="ts">
import { QuestionFilled } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';

import {
  createTable,
  FIELD_TYPES,
  getTableTemplate,
  listTableTemplates,
  type CreateFieldInput,
  type FieldType,
  type TableTemplateSummary,
} from '../../api/tables.js';
import { getApiErrorMessage } from '../../api/errors.js';
import EnumOptionEditor from '../../components/EnumOptionEditor.vue';
import VDialog from '../../components/v-dialog.vue';
import { newEnumOption } from '../../enum-options.logic.js';
import {
  FIELD_NAME_HELP,
  FIELD_TYPE_DESCRIPTIONS,
  getFieldTypeNotice,
} from '../../field-types.logic.js';
import { useFieldTypesStore } from '../../stores/field-types.js';
import {
  applyTableTemplate,
  getTableStatusLabel,
  hasTemplateContentToOverwrite,
  toCreateTableInput,
  validateCreateTableForm,
  type CreateTableFormValue,
} from './tables.logic.js';

const props = defineProps<{ canReadTemplates: boolean }>();
const emit = defineEmits<{ close: []; reload: [] }>();

interface EditableField extends CreateFieldInput {
  rowId: number;
}

interface EditableCreateTableForm {
  displayName: string;
  description: string;
  fields: EditableField[];
}

const FIELD_TYPE_LABELS = {
  string: '文本',
  enum: '枚举',
  boolean: '布尔值',
  integer: '整数',
  float: '小数',
  datetime: '时间',
} as const satisfies Record<FieldType, string>;

const fieldTypesStore = useFieldTypesStore();
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
const createFormValue = computed<CreateTableFormValue>(() => ({
  displayName: form.displayName,
  description: form.description,
  fields: form.fields,
}));
const validation = computed(() => validateCreateTableForm(createFormValue.value));

function makeEditableField(field?: CreateFieldInput): EditableField {
  return {
    rowId: nextRowId++,
    key: field?.key ?? '',
    label: field?.label ?? '',
    type: field?.type ?? 'string',
    required: field?.required ?? false,
    description: field?.description ?? '',
    ...(field?.type === 'enum'
      ? {
          options:
            field.options === undefined || field.options.length === 0
              ? [newEnumOption()]
              : field.options.map((option) => ({ ...option })),
        }
      : {}),
  };
}

function handleFieldTypeChange(field: EditableField): void {
  if (field.type === 'enum') {
    field.options = field.options?.length ? field.options : [newEnumOption()];
  } else {
    delete field.options;
  }
}

async function loadTemplates(): Promise<void> {
  if (!props.canReadTemplates) {
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

function closeDialog(): void {
  if (!createSubmitting.value) {
    emit('close');
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
    emit('close');
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    emit('reload');
    createSubmitting.value = false;
  }
}

onMounted(() => {
  if (props.canReadTemplates) {
    void loadTemplates();
  }
});
</script>

<template>
  <v-dialog
    width="min(960px, calc(100vw - 32px))"
    :loading="createSubmitting"
    fix-top
    @close="closeDialog"
  >
    <template #header>创建数据采集表</template>
    <template #body>
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
                  required
                  :error="validationAttempted ? validation.fields[index]?.label : undefined"
                >
                  <template #label>
                    <span class="field-label-with-help">
                      字段名称
                      <el-tooltip :content="FIELD_NAME_HELP" placement="top" :show-after="200">
                        <el-icon class="field-help-icon" tabindex="0" aria-label="字段名说明">
                          <QuestionFilled />
                        </el-icon>
                      </el-tooltip>
                    </span>
                  </template>
                  <el-input v-model="field.label" placeholder="例如 事件名" />
                </el-form-item>
                <el-form-item label="字段类型">
                  <div class="field-type-control">
                    <el-select v-model="field.type" @change="handleFieldTypeChange(field)">
                      <el-option
                        v-for="fieldType in FIELD_TYPES"
                        :key="fieldType"
                        :label="FIELD_TYPE_LABELS[fieldType]"
                        :value="fieldType"
                      >
                        <div class="field-type-option">
                          <strong>{{ FIELD_TYPE_LABELS[fieldType] }}</strong>
                          <span>{{ FIELD_TYPE_DESCRIPTIONS[fieldType] }}</span>
                        </div>
                      </el-option>
                    </el-select>
                    <p
                      v-if="getFieldTypeNotice(field.type, fieldTypesStore.response?.limits)"
                      class="field-type-notice"
                    >
                      {{ getFieldTypeNotice(field.type, fieldTypesStore.response?.limits) }}
                    </p>
                  </div>
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
              <EnumOptionEditor
                v-if="field.type === 'enum'"
                v-model="field.options!"
                :validation-attempted="validationAttempted"
              />
              <el-alert
                v-if="validationAttempted && validation.fields[index]?.options"
                :title="validation.fields[index]?.options"
                type="error"
                :closable="false"
                show-icon
              />
            </article>
          </div>
        </section>
      </el-form>
    </template>
    <el-button :disabled="createSubmitting" @click="closeDialog">取消</el-button>
    <el-button type="primary" :loading="createSubmitting" @click="submitCreateTable">
      创建
    </el-button>
  </v-dialog>
</template>

<style scoped src="./tables-create-dialog.css"></style>
