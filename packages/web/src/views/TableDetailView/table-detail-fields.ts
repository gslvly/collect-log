import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, reactive, ref, type ComputedRef, type Ref } from 'vue';

import { getApiErrorMessage } from '../../api/errors.js';
import { getTableStatistics, type StatisticsRow } from '../../api/query.js';
import {
  addTableField,
  deprecateTableField,
  renameTableField,
  retypeTableField,
  updateTableField,
  updateTableFieldOptions,
  type CollectionField,
  type CollectionTable,
  type FieldOptionInput,
} from '../../api/tables.js';
import {
  canRegisterEnumValue,
  cloneEnumOptions,
  hasNewlyDisabledOption,
  newEnumOption,
  validateEnumOptions,
} from '../../enum-options.logic.js';
import { useTimezoneStore } from '../../stores/timezone.js';
import {
  buildRetypeFieldInput,
  buildRetypeTopValuesQuery,
  buildUpdateFieldInput,
  canRetypeField,
  topGroupsToEnumOptions,
  toCreateFieldInput,
  validateAddFieldForm,
  validateEditFieldForm,
  validateFieldKey,
  type AddFieldFormValue,
  type EditFieldFormValue,
} from './table-detail.logic.js';

type TopValuesState = 'idle' | 'loading' | 'ready' | 'error';

export function useTableDetailFieldActions(options: {
  projectId: ComputedRef<string>;
  fields: Ref<CollectionField[]>;
  applyTable: (table: CollectionTable) => void;
  loadDetail: () => Promise<void>;
}) {
  const { projectId, fields, applyTable, loadDetail } = options;
  const timezoneStore = useTimezoneStore();
  const addDialogVisible = ref(false);
  const addSubmitting = ref(false);
  const addValidationAttempted = ref(false);
  const addForm = reactive<AddFieldFormValue>({
    key: '',
    label: '',
    type: 'string',
    required: false,
    description: '',
    options: [],
  });
  const addValidation = computed(() => validateAddFieldForm(addForm, fields.value));

  function resetAddForm(): void {
    addForm.key = '';
    addForm.label = '';
    addForm.type = 'string';
    addForm.required = false;
    addForm.description = '';
    addForm.options = [];
    addValidationAttempted.value = false;
  }

  function handleAddFieldTypeChange(): void {
    addForm.options = addForm.type === 'enum' ? [newEnumOption()] : [];
  }

  function openAddDialog(): void {
    resetAddForm();
    addDialogVisible.value = true;
  }

  function closeAddDialog(): void {
    if (!addSubmitting.value) {
      addDialogVisible.value = false;
      resetAddForm();
    }
  }

  async function submitAddField(): Promise<void> {
    addValidationAttempted.value = true;
    if (!addValidation.value.valid) {
      return;
    }
    addSubmitting.value = true;
    try {
      await addTableField(projectId.value, toCreateFieldInput(addForm));
      ElMessage.success('字段新增成功');
      addDialogVisible.value = false;
      await loadDetail();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      addSubmitting.value = false;
    }
  }

  const editDialogVisible = ref(false);
  const editSubmitting = ref(false);
  const editValidationAttempted = ref(false);
  const editingField = ref<CollectionField | null>(null);
  const editForm = reactive<EditFieldFormValue>({ label: '', required: false, description: '' });
  const editValidation = computed(() =>
    editingField.value === null
      ? { valid: false, form: '请选择字段' }
      : validateEditFieldForm(editingField.value, editForm),
  );
  const requiredWillChange = computed(
    () => editingField.value !== null && editForm.required !== editingField.value.required,
  );

  function openEditDialog(field: CollectionField): void {
    editingField.value = field;
    editForm.label = field.label;
    editForm.required = field.required;
    editForm.description = field.description;
    editValidationAttempted.value = false;
    editDialogVisible.value = true;
  }

  function resetEditForm(): void {
    editingField.value = null;
    editValidationAttempted.value = false;
  }

  async function submitEditField(): Promise<void> {
    const current = editingField.value;
    if (current === null) {
      return;
    }
    editValidationAttempted.value = true;
    if (!editValidation.value.valid) {
      return;
    }
    editSubmitting.value = true;
    try {
      await updateTableField(projectId.value, current.key, buildUpdateFieldInput(current, editForm));
      ElMessage.success('字段配置已更新');
      editDialogVisible.value = false;
      await loadDetail();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      editSubmitting.value = false;
    }
  }

  const optionDialogVisible = ref(false);
  const optionSubmitting = ref(false);
  const optionValidationAttempted = ref(false);
  const optionEditingField = ref<CollectionField | null>(null);
  const optionDrafts = ref<FieldOptionInput[]>([]);
  const optionLockedValues = computed(
    () => optionEditingField.value?.options.map((option) => option.value) ?? [],
  );
  const optionValidation = computed(() => validateEnumOptions(optionDrafts.value));
  const optionWillDisable = computed(
    () =>
      optionEditingField.value !== null &&
      hasNewlyDisabledOption(optionEditingField.value.options, optionDrafts.value),
  );

  function openOptionDialog(field: CollectionField): void {
    optionEditingField.value = field;
    optionDrafts.value = cloneEnumOptions(field.options);
    optionValidationAttempted.value = false;
    optionDialogVisible.value = true;
  }

  function closeOptionDialog(): void {
    if (!optionSubmitting.value) {
      optionDialogVisible.value = false;
      resetOptionDialog();
    }
  }

  function resetOptionDialog(): void {
    optionEditingField.value = null;
    optionDrafts.value = [];
    optionValidationAttempted.value = false;
  }

  async function submitFieldOptions(): Promise<void> {
    const current = optionEditingField.value;
    if (current === null) {
      return;
    }
    optionValidationAttempted.value = true;
    if (!optionValidation.value.valid) {
      return;
    }
    optionSubmitting.value = true;
    try {
      const response = await updateTableFieldOptions(
        projectId.value,
        current.key,
        optionDrafts.value,
      );
      applyTable(response.table);
      ElMessage.success('枚举选项已更新');
      optionDialogVisible.value = false;
      resetOptionDialog();
      await loadDetail();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      optionSubmitting.value = false;
    }
  }

  const retypeDialogVisible = ref(false);
  const retypeSubmitting = ref(false);
  const retypeValidationAttempted = ref(false);
  const retypingField = ref<CollectionField | null>(null);
  const retypeOptions = ref<FieldOptionInput[]>([]);
  const topValuesState = ref<TopValuesState>('idle');
  const topValues = ref<StatisticsRow[]>([]);
  const topValuesError = ref('');
  const retypeOptionValidation = computed(() => validateEnumOptions(retypeOptions.value));
  const retypeToEnum = computed(() => retypingField.value?.type === 'string');

  function isTopValueSelected(value: StatisticsRow['key']): boolean {
    return typeof value === 'string' && retypeOptions.value.some((option) => option.value === value);
  }

  function toggleTopValue(value: StatisticsRow['key'], selected: boolean): void {
    if (typeof value !== 'string' || !canRegisterEnumValue(value)) {
      return;
    }
    if (selected) {
      if (!isTopValueSelected(value)) {
        retypeOptions.value = [...retypeOptions.value, { value, label: value, status: 'active' }];
      }
      return;
    }
    retypeOptions.value = retypeOptions.value.filter((option) => option.value !== value);
  }

  async function loadRetypeTopValues(): Promise<void> {
    const current = retypingField.value;
    if (current === null || current.type !== 'string') {
      return;
    }
    topValuesState.value = 'loading';
    topValuesError.value = '';
    try {
      const response = await getTableStatistics(
        projectId.value,
        buildRetypeTopValuesQuery(current.key, timezoneStore.timeZone),
      );
      if (response.dimension !== 'field') {
        throw new Error('Top 值接口返回了无法识别的结果');
      }
      topValues.value = response.rows;
      retypeOptions.value = topGroupsToEnumOptions(response.rows);
      if (retypeOptions.value.length === 0) {
        retypeOptions.value = [newEnumOption()];
      }
      topValuesState.value = 'ready';
    } catch (error) {
      topValuesError.value = getApiErrorMessage(error);
      topValuesState.value = 'error';
      if (retypeOptions.value.length === 0) {
        retypeOptions.value = [newEnumOption()];
      }
    }
  }

  function openRetypeDialog(field: CollectionField): void {
    if (!canRetypeField(field)) {
      return;
    }
    retypingField.value = field;
    retypeOptions.value = field.type === 'string' ? [] : cloneEnumOptions(field.options);
    retypeValidationAttempted.value = false;
    topValues.value = [];
    topValuesError.value = '';
    topValuesState.value = field.type === 'string' ? 'idle' : 'ready';
    retypeDialogVisible.value = true;
    if (field.type === 'string') {
      void loadRetypeTopValues();
    }
  }

  function closeRetypeDialog(): void {
    if (!retypeSubmitting.value) {
      retypeDialogVisible.value = false;
      resetRetypeDialog();
    }
  }

  function resetRetypeDialog(): void {
    retypingField.value = null;
    retypeOptions.value = [];
    retypeValidationAttempted.value = false;
    topValuesState.value = 'idle';
    topValues.value = [];
    topValuesError.value = '';
  }

  async function submitRetypeField(): Promise<void> {
    const current = retypingField.value;
    if (current === null) {
      return;
    }
    retypeValidationAttempted.value = true;
    if (current.type === 'string' && !retypeOptionValidation.value.valid) {
      return;
    }
    retypeSubmitting.value = true;
    try {
      const response = await retypeTableField(
        projectId.value,
        current.key,
        buildRetypeFieldInput(current, retypeOptions.value),
      );
      applyTable(response.table);
      ElMessage.success(response.message);
      retypeDialogVisible.value = false;
      resetRetypeDialog();
      await loadDetail();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      retypeSubmitting.value = false;
    }
  }

  const renameDialogVisible = ref(false);
  const renameSubmitting = ref(false);
  const renameValidationAttempted = ref(false);
  const renamingField = ref<CollectionField | null>(null);
  const renamedKey = ref('');
  const renamedKeyError = computed(() => validateFieldKey(renamedKey.value, fields.value));

  function openRenameDialog(field: CollectionField): void {
    renamingField.value = field;
    renamedKey.value = '';
    renameValidationAttempted.value = false;
    renameDialogVisible.value = true;
  }

  function resetRenameForm(): void {
    renamingField.value = null;
    renamedKey.value = '';
    renameValidationAttempted.value = false;
  }

  async function submitRenameField(): Promise<void> {
    const current = renamingField.value;
    if (current === null) {
      return;
    }
    renameValidationAttempted.value = true;
    if (renamedKeyError.value !== undefined) {
      return;
    }
    try {
      await ElMessageBox.confirm(
        `字段 ${current.key} 将重命名为 ${renamedKey.value}。前端上报代码需同步改用新 Key，否则旧 Key 的上报会被拒绝。`,
        '确认重命名字段？',
        {
          type: 'warning',
          confirmButtonText: '确认重命名',
          cancelButtonText: '取消',
        },
      );
    } catch {
      return;
    }

    renameSubmitting.value = true;
    try {
      const response = await renameTableField(projectId.value, current.key, renamedKey.value);
      ElMessage.success(response.message);
      renameDialogVisible.value = false;
      await loadDetail();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      renameSubmitting.value = false;
    }
  }

  async function deprecateField(field: CollectionField): Promise<void> {
    try {
      await ElMessageBox.confirm(
        '软废弃后历史数据与物理列继续保留；新的上报会被拒绝，新建查询默认隐藏该字段。',
        `确认软废弃字段 ${field.key}？`,
        {
          type: 'warning',
          confirmButtonText: '确认软废弃',
          cancelButtonText: '取消',
        },
      );
    } catch {
      return;
    }

    try {
      await deprecateTableField(projectId.value, field.key);
      ElMessage.success('字段已软废弃，历史数据与物理列仍保留');
      await loadDetail();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    }
  }

  return {
    addDialogVisible,
    addForm,
    addSubmitting,
    addValidation,
    addValidationAttempted,
    closeAddDialog,
    closeOptionDialog,
    closeRetypeDialog,
    deprecateField,
    editDialogVisible,
    editForm,
    editSubmitting,
    editValidation,
    editValidationAttempted,
    editingField,
    handleAddFieldTypeChange,
    isTopValueSelected,
    loadRetypeTopValues,
    openAddDialog,
    openEditDialog,
    openOptionDialog,
    openRenameDialog,
    openRetypeDialog,
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
  };
}
