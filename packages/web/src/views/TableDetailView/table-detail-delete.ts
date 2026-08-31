import { ElMessage } from 'element-plus';
import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { Router } from 'vue-router';

import { getApiErrorMessage } from '../../api/errors.js';
import {
  deleteTable,
  deleteTableField,
  getTableFieldUsage,
  getTableRowCount,
  type CollectionField,
  type CollectionTable,
} from '../../api/tables.js';
import { isFieldDeletionConfirmed, isTableDeletionConfirmed } from './table-detail.logic.js';

export type CountState = 'idle' | 'loading' | 'ready' | 'error';

export function useTableDetailDelete(options: {
  projectId: ComputedRef<string>;
  table: Ref<CollectionTable | null>;
  tableDeletionAllowed: ComputedRef<boolean>;
  loadDetail: () => Promise<void>;
  router: Router;
}) {
  const { projectId, table, tableDeletionAllowed, loadDetail, router } = options;
  const fieldDeleteFirstVisible = ref(false);
  const fieldDeleteSecondVisible = ref(false);
  const deletingField = ref<CollectionField | null>(null);
  const fieldUsageState = ref<CountState>('idle');
  const fieldUsageCount = ref(0);
  const fieldUsageError = ref('');
  const fieldDeleteConfirmation = ref('');
  const fieldDeleteSubmitting = ref(false);
  const fieldDeleteConfirmed = computed(
    () =>
      deletingField.value !== null &&
      isFieldDeletionConfirmed(fieldDeleteConfirmation.value, deletingField.value.key),
  );

  async function loadFieldUsage(): Promise<void> {
    const current = deletingField.value;
    if (current === null) {
      return;
    }
    fieldUsageState.value = 'loading';
    fieldUsageError.value = '';
    try {
      const response = await getTableFieldUsage(projectId.value, current.key);
      fieldUsageCount.value = response.count;
      fieldUsageState.value = 'ready';
    } catch (error) {
      fieldUsageError.value = getApiErrorMessage(error);
      fieldUsageState.value = 'error';
    }
  }

  function openFieldDelete(field: CollectionField): void {
    deletingField.value = field;
    fieldDeleteConfirmation.value = '';
    fieldUsageState.value = 'idle';
    fieldUsageError.value = '';
    fieldDeleteFirstVisible.value = true;
    void loadFieldUsage();
  }

  function continueFieldDelete(): void {
    fieldDeleteFirstVisible.value = false;
    fieldDeleteSecondVisible.value = true;
  }

  function resetFieldDelete(): void {
    if (fieldDeleteSecondVisible.value || fieldDeleteSubmitting.value) {
      return;
    }
    deletingField.value = null;
    fieldDeleteConfirmation.value = '';
    fieldUsageState.value = 'idle';
    fieldUsageError.value = '';
  }

  async function submitFieldDelete(): Promise<void> {
    const current = deletingField.value;
    if (current === null || !fieldDeleteConfirmed.value) {
      return;
    }
    fieldDeleteSubmitting.value = true;
    try {
      await deleteTableField(projectId.value, current.key, current.key);
      ElMessage.success('该列历史数据已永久删除、不可恢复');
      fieldDeleteSecondVisible.value = false;
      await loadDetail();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      fieldDeleteSubmitting.value = false;
      if (!fieldDeleteSecondVisible.value) {
        resetFieldDelete();
      }
    }
  }

  function handleFieldMoreCommand(command: string, field: CollectionField): void {
    if (command === 'delete') {
      openFieldDelete(field);
    }
  }

  const tableDeleteFirstVisible = ref(false);
  const tableDeleteSecondVisible = ref(false);
  const tableRowCountState = ref<CountState>('idle');
  const tableRowCount = ref(0);
  const tableRowCountError = ref('');
  const tableDeleteConfirmation = ref('');
  const tableDeleteSubmitting = ref(false);
  const tableDeleteConfirmed = computed(
    () =>
      table.value !== null &&
      isTableDeletionConfirmed(tableDeleteConfirmation.value, table.value.displayName),
  );

  async function loadTableRowCount(): Promise<void> {
    tableRowCountState.value = 'loading';
    tableRowCountError.value = '';
    try {
      const response = await getTableRowCount(projectId.value);
      tableRowCount.value = response.count;
      tableRowCountState.value = 'ready';
    } catch (error) {
      tableRowCountError.value = getApiErrorMessage(error);
      tableRowCountState.value = 'error';
    }
  }

  function openTableDelete(): void {
    if (!tableDeletionAllowed.value) {
      return;
    }
    tableDeleteConfirmation.value = '';
    tableRowCountState.value = 'idle';
    tableRowCountError.value = '';
    tableDeleteFirstVisible.value = true;
    void loadTableRowCount();
  }

  function continueTableDelete(): void {
    tableDeleteFirstVisible.value = false;
    tableDeleteSecondVisible.value = true;
  }

  async function submitTableDelete(): Promise<void> {
    const current = table.value;
    if (current === null || !tableDeleteConfirmed.value) {
      return;
    }
    tableDeleteSubmitting.value = true;
    try {
      await deleteTable(projectId.value, current.displayName);
      tableDeleteSecondVisible.value = false;
      await router.push('/tables');
      ElMessage.success('已永久删除，无法恢复');
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      tableDeleteSubmitting.value = false;
    }
  }

  return {
    continueFieldDelete,
    continueTableDelete,
    deletingField,
    fieldDeleteConfirmation,
    fieldDeleteConfirmed,
    fieldDeleteFirstVisible,
    fieldDeleteSecondVisible,
    fieldDeleteSubmitting,
    fieldUsageCount,
    fieldUsageError,
    fieldUsageState,
    handleFieldMoreCommand,
    loadFieldUsage,
    loadTableRowCount,
    openTableDelete,
    resetFieldDelete,
    submitFieldDelete,
    submitTableDelete,
    tableDeleteConfirmation,
    tableDeleteConfirmed,
    tableDeleteFirstVisible,
    tableDeleteSecondVisible,
    tableDeleteSubmitting,
    tableRowCount,
    tableRowCountError,
    tableRowCountState,
  };
}
