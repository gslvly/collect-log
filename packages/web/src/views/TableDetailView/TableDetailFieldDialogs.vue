<script setup lang="ts">
import { QuestionFilled } from '@element-plus/icons-vue';

import EnumOptionEditor from '../../components/EnumOptionEditor.vue';
import VDialog from '../../components/v-dialog.vue';
import { FIELD_TYPES } from '../../api/tables.js';
import { canRegisterEnumValue } from '../../enum-options.logic.js';
import {
  FIELD_NAME_HELP,
  FIELD_TYPE_DESCRIPTIONS,
  getFieldTypeNotice,
} from '../../field-types.logic.js';
import { useFieldTypesStore } from '../../stores/field-types.js';
import { useTableDetailDelete } from './table-detail-delete.js';
import { useTableDetailFieldActions } from './table-detail-fields.js';
import { FIELD_TYPE_LABELS } from './table-detail.logic.js';

const props = defineProps<{
  fieldActions: ReturnType<typeof useTableDetailFieldActions>;
  deleteActions: ReturnType<typeof useTableDetailDelete>;
}>();

const fieldTypesStore = useFieldTypesStore();
const {
  addDialogVisible,
  addForm,
  addSubmitting,
  addValidation,
  addValidationAttempted,
  closeAddDialog,
  closeOptionDialog,
  closeRetypeDialog,
  editDialogVisible,
  editForm,
  editSubmitting,
  editValidation,
  editValidationAttempted,
  editingField,
  handleAddFieldTypeChange,
  isTopValueSelected,
  loadRetypeTopValues,
  optionDialogVisible,
  optionDrafts,
  optionEditingField,
  optionLockedValues,
  optionSubmitting,
  optionValidationAttempted,
  optionWillDisable,
  renamedKey,
  renamedKeyError,
  renameDialogVisible,
  renameSubmitting,
  renameValidationAttempted,
  renamingField,
  requiredWillChange,
  resetEditForm,
  resetRenameForm,
  retypeDialogVisible,
  retypeOptions,
  retypeSubmitting,
  retypeToEnum,
  retypeValidationAttempted,
  retypingField,
  submitAddField,
  submitEditField,
  submitFieldOptions,
  submitRenameField,
  submitRetypeField,
  toggleTopValue,
  topValues,
  topValuesError,
  topValuesState,
} = props.fieldActions;
const {
  continueFieldDelete,
  deletingField,
  fieldDeleteConfirmation,
  fieldDeleteConfirmed,
  fieldDeleteFirstVisible,
  fieldDeleteSecondVisible,
  fieldDeleteSubmitting,
  fieldUsageCount,
  fieldUsageError,
  fieldUsageState,
  loadFieldUsage,
  resetFieldDelete,
  submitFieldDelete,
} = props.deleteActions;

function closeEditDialog(): void {
  editDialogVisible.value = false;
  resetEditForm();
}

function closeRenameDialog(): void {
  renameDialogVisible.value = false;
  resetRenameForm();
}

function closeFieldDeleteFirst(): void {
  fieldDeleteFirstVisible.value = false;
  resetFieldDelete();
}

function closeFieldDeleteSecond(): void {
  fieldDeleteSecondVisible.value = false;
  resetFieldDelete();
}
</script>

<template>
  <v-dialog
    v-if="addDialogVisible"
    width="min(680px, calc(100vw - 32px))"
    :loading="addSubmitting"
    @close="closeAddDialog"
  >
    <template #header>新增字段</template>
    <template #body>
      <el-form label-position="top" @submit.prevent="submitAddField">
        <el-form-item
          label="字段 Key"
          required
          :error="addValidationAttempted ? addValidation.key : undefined"
        >
          <el-input v-model="addForm.key" placeholder="例如 event_name" />
        </el-form-item>
        <el-form-item required :error="addValidationAttempted ? addValidation.label : undefined">
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
          <el-input v-model="addForm.label" placeholder="例如 事件名" />
        </el-form-item>
        <div class="dialog-grid">
          <el-form-item label="字段类型">
            <div class="field-type-control">
              <el-select v-model="addForm.type" @change="handleAddFieldTypeChange">
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
                v-if="getFieldTypeNotice(addForm.type, fieldTypesStore.response?.limits)"
                class="field-type-notice"
              >
                {{ getFieldTypeNotice(addForm.type, fieldTypesStore.response?.limits) }}
              </p>
            </div>
          </el-form-item>
          <el-form-item label="必填">
            <el-switch
              v-model="addForm.required"
              inline-prompt
              active-text="是"
              inactive-text="否"
            />
          </el-form-item>
        </div>
        <el-form-item label="字段说明">
          <el-input v-model="addForm.description" type="textarea" :rows="3" />
        </el-form-item>
        <EnumOptionEditor
          v-if="addForm.type === 'enum'"
          v-model="addForm.options"
          :validation-attempted="addValidationAttempted"
        />
        <el-alert
          v-if="addValidationAttempted && addValidation.options"
          :title="addValidation.options"
          type="error"
          :closable="false"
          show-icon
        />
      </el-form>
    </template>
    <el-button :disabled="addSubmitting" @click="closeAddDialog">取消</el-button>
    <el-button type="primary" :loading="addSubmitting" @click="submitAddField">新增</el-button>
  </v-dialog>

  <v-dialog
    v-if="editDialogVisible"
    width="560px"
    :loading="editSubmitting"
    @close="closeEditDialog"
  >
    <template #header>编辑字段 {{ editingField?.key ?? '' }}</template>
    <template #body>
      <el-form label-position="top" @submit.prevent="submitEditField">
        <el-alert
          v-if="requiredWillChange"
          title="修改必填规则会影响上报校验，并使 Schema 版本加一。"
          type="warning"
          :closable="false"
          show-icon
        />
        <el-form-item required :error="editValidationAttempted ? editValidation.label : undefined">
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
          <el-input v-model="editForm.label" />
        </el-form-item>
        <el-form-item label="必填">
          <el-switch
            v-model="editForm.required"
            inline-prompt
            active-text="是"
            inactive-text="否"
          />
        </el-form-item>
        <el-form-item label="字段说明">
          <el-input v-model="editForm.description" type="textarea" :rows="3" />
        </el-form-item>
        <el-alert
          v-if="editValidationAttempted && editValidation.form"
          :title="editValidation.form"
          type="error"
          :closable="false"
          show-icon
        />
      </el-form>
    </template>
    <el-button :disabled="editSubmitting" @click="closeEditDialog">取消</el-button>
    <el-button type="primary" :loading="editSubmitting" @click="submitEditField">保存</el-button>
  </v-dialog>

  <v-dialog
    v-if="optionDialogVisible"
    width="min(860px, calc(100vw - 32px))"
    :loading="optionSubmitting"
    @close="closeOptionDialog"
  >
    <template #header>编辑枚举选项 · {{ optionEditingField?.key }}</template>
    <template #body>
      <div class="custom-dialog-stack">
        <el-alert
          v-if="optionWillDisable"
          title="停用后历史数据仍可查询与分组，但携带该值的新上报会被拒绝。"
          type="warning"
          :closable="false"
          show-icon
        />
        <EnumOptionEditor
          v-model="optionDrafts"
          :locked-values="optionLockedValues"
          :validation-attempted="optionValidationAttempted"
        />
      </div>
    </template>
    <el-button :disabled="optionSubmitting" @click="closeOptionDialog">取消</el-button>
    <el-button type="primary" :loading="optionSubmitting" @click="submitFieldOptions">
      保存选项
    </el-button>
  </v-dialog>

  <v-dialog
    v-if="retypeDialogVisible"
    width="min(900px, calc(100vw - 32px))"
    :loading="retypeSubmitting"
    @close="closeRetypeDialog"
  >
    <template #header>
      {{ retypeToEnum ? '转换为枚举' : '转换为文本' }} · {{ retypingField?.key }}
    </template>
    <template #body>
      <div class="custom-dialog-stack">
        <el-alert
          :title="
            retypeToEnum
              ? '历史数据完整保留；未登记的历史值仍可查询与分组，但该值今后的新上报会被拒绝。'
              : '历史数据完整保留；转换后该字段不再限制值域，现有枚举选项会从字段配置中移除。'
          "
          type="warning"
          :closable="false"
          show-icon
        />

        <template v-if="retypeToEnum">
          <section class="top-values-panel">
            <header>
              <div>
                <strong>最近 92 天 Top 值</strong>
                <p>默认登记可用值；取消勾选的历史值，今后的新上报会被拒绝。</p>
              </div>
              <el-button :loading="topValuesState === 'loading'" @click="loadRetypeTopValues">
                重新拉取
              </el-button>
            </header>
            <el-skeleton v-if="topValuesState === 'loading'" :rows="3" animated />
            <el-alert
              v-else-if="topValuesState === 'error'"
              :title="topValuesError"
              type="error"
              :closable="false"
              show-icon
            />
            <el-empty
              v-else-if="topValuesState === 'ready' && topValues.length === 0"
              description="最近 92 天没有非空历史值，请手动登记选项"
            />
            <div v-else-if="topValues.length > 0" class="top-value-list">
              <label v-for="group in topValues" :key="String(group.key)" class="top-value-row">
                <el-checkbox
                  :model-value="isTopValueSelected(group.key)"
                  :disabled="!canRegisterEnumValue(group.key)"
                  @change="(selected: boolean) => toggleTopValue(group.key, selected)"
                />
                <code>{{
                  group.key === null
                    ? '（未提交，不能登记）'
                    : group.key === ''
                      ? '（空字符串，不能登记）'
                      : group.key
                }}</code>
                <span>{{ group.rows.toLocaleString('zh-CN') }} 行</span>
              </label>
            </div>
          </section>

          <EnumOptionEditor
            v-model="retypeOptions"
            :validation-attempted="retypeValidationAttempted"
          />
        </template>

        <section v-else class="enum-release-summary">
          <strong>将移除 {{ retypingField?.options.length ?? 0 }} 个选项约束</strong>
          <p>选项只从 SQLite 元数据删除，ClickHouse 列中的字符串值一个字节都不会改变。</p>
          <div class="released-options">
            <el-tag
              v-for="option in retypingField?.options ?? []"
              :key="option.value"
              :type="option.status === 'active' ? 'primary' : 'info'"
              effect="plain"
            >
              {{ option.label }} · {{ option.value }}
            </el-tag>
          </div>
        </section>
      </div>
    </template>
    <el-button :disabled="retypeSubmitting" @click="closeRetypeDialog">取消</el-button>
    <el-button type="primary" :loading="retypeSubmitting" @click="submitRetypeField">
      确认{{ retypeToEnum ? '转换为枚举' : '转换为文本' }}
    </el-button>
  </v-dialog>

  <v-dialog
    v-if="renameDialogVisible"
    width="520px"
    :loading="renameSubmitting"
    @close="closeRenameDialog"
  >
    <template #header>重命名字段 {{ renamingField?.key ?? '' }}</template>
    <template #body>
      <el-alert
        title="前端上报代码需同步改用新 Key，否则旧 Key 的上报会被拒绝"
        type="warning"
        :closable="false"
        show-icon
      />
      <el-form label-position="top" @submit.prevent="submitRenameField">
        <el-form-item
          label="新 Key"
          required
          :error="renameValidationAttempted ? renamedKeyError : undefined"
        >
          <el-input v-model="renamedKey" placeholder="请输入新的字段 Key" />
        </el-form-item>
      </el-form>
    </template>
    <el-button :disabled="renameSubmitting" @click="closeRenameDialog">取消</el-button>
    <el-button type="primary" :loading="renameSubmitting" @click="submitRenameField">
      继续
    </el-button>
  </v-dialog>

  <v-dialog
    v-if="fieldDeleteFirstVisible"
    width="600px"
    :loading="fieldUsageState === 'loading'"
    @close="closeFieldDeleteFirst"
  >
    <template #header>此操作将永久删除该字段的全部历史数据</template>
    <template #body>
      <template v-if="deletingField">
        <el-alert
          title="物理删除会销毁该列的全部历史数据，无法恢复。之后可以用同名 Key 新建一列全新的空列。"
          type="error"
          :closable="false"
          show-icon
        />
        <el-descriptions :column="1" border class="confirmation-details">
          <el-descriptions-item label="字段 Key">{{ deletingField.key }}</el-descriptions-item>
          <el-descriptions-item label="字段名称">{{ deletingField.label }}</el-descriptions-item>
          <el-descriptions-item label="字段类型">
            {{ FIELD_TYPE_LABELS[deletingField.type] }}
          </el-descriptions-item>
          <el-descriptions-item label="当前非空行数">
            <span v-if="fieldUsageState === 'loading'">查询中…</span>
            <span v-else-if="fieldUsageState === 'ready'">
              {{ fieldUsageCount.toLocaleString('zh-CN') }}
            </span>
            <span v-else-if="fieldUsageState === 'error'" class="count-error">
              行数获取失败：{{ fieldUsageError }}
              <el-button link type="primary" @click="loadFieldUsage">重试</el-button>
            </span>
          </el-descriptions-item>
        </el-descriptions>
      </template>
    </template>
    <el-button @click="closeFieldDeleteFirst">取消</el-button>
    <el-button type="danger" :disabled="fieldUsageState !== 'ready'" @click="continueFieldDelete">
      我了解后果，继续
    </el-button>
  </v-dialog>

  <v-dialog
    v-if="fieldDeleteSecondVisible"
    width="520px"
    :loading="fieldDeleteSubmitting"
    :show-close="!fieldDeleteSubmitting"
    @close="closeFieldDeleteSecond"
  >
    <template #header>二次确认：输入字段 Key</template>
    <template #body>
      <p>
        请手动输入 <code>{{ deletingField?.key }}</code
        >，完全一致后才能永久删除。
      </p>
      <el-input
        v-model="fieldDeleteConfirmation"
        :placeholder="deletingField?.key"
        autocomplete="off"
      />
    </template>
    <el-button :disabled="fieldDeleteSubmitting" @click="closeFieldDeleteSecond"> 取消 </el-button>
    <el-button
      type="danger"
      :loading="fieldDeleteSubmitting"
      :disabled="!fieldDeleteConfirmed"
      @click="submitFieldDelete"
    >
      永久删除字段
    </el-button>
  </v-dialog>
</template>

<style scoped src="./table-detail-view.css"></style>
