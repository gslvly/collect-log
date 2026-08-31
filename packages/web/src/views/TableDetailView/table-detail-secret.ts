import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { getApiErrorMessage } from '../../api/errors.js';
import {
  getTableSecret,
  rotateTableSecret,
  type CollectionField,
  type CollectionTable,
} from '../../api/tables.js';
import { buildIntegrationUsageCode } from './table-detail.logic.js';

export function useTableDetailSecret(options: {
  projectId: ComputedRef<string>;
  table: Ref<CollectionTable | null>;
  fields: Ref<CollectionField[]>;
  canManageSecret: ComputedRef<boolean>;
}) {
  const { projectId, table, fields, canManageSecret } = options;
  const secret = ref('');
  const secretVisible = ref(false);
  const secretLoading = ref(false);
  const secretError = ref('');
  const displayedSecret = computed(() => (secretVisible.value ? secret.value : '••••'));
  const integrationUsageCode = computed(() =>
    table.value === null || secret.value === ''
      ? ''
      : buildIntegrationUsageCode(
          window.location.origin,
          table.value.projectId,
          secretVisible.value ? secret.value : '••••',
          fields.value,
        ),
  );

  async function loadSecret(force = false): Promise<void> {
    if (!canManageSecret.value || (secret.value !== '' && !force) || secretLoading.value) {
      return;
    }
    secretLoading.value = true;
    secretError.value = '';
    try {
      const response = await getTableSecret(projectId.value);
      secret.value = response.ingestSecret;
      secretVisible.value = false;
    } catch (error) {
      secretError.value = getApiErrorMessage(error);
    } finally {
      secretLoading.value = false;
    }
  }

  function handleTabChange(name: string | number): void {
    if (name === 'integration') {
      void loadSecret();
    }
  }

  async function rotateSecret(): Promise<void> {
    try {
      await ElMessageBox.confirm(
        '轮换后旧密钥进入 7 天灰度期，灰度期结束后失效。前端埋点需在灰度期内换上新密钥。',
        '确认轮换上报密钥？',
        {
          type: 'warning',
          confirmButtonText: '确认轮换',
          cancelButtonText: '取消',
        },
      );
    } catch {
      return;
    }

    secretLoading.value = true;
    try {
      const response = await rotateTableSecret(projectId.value);
      secret.value = response.ingestSecret;
      secretVisible.value = true;
      secretError.value = '';
      ElMessage.success('密钥已轮换，请在 7 天灰度期内更新前端埋点');
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      secretLoading.value = false;
    }
  }

  return {
    displayedSecret,
    handleTabChange,
    integrationUsageCode,
    loadSecret,
    rotateSecret,
    secret,
    secretError,
    secretLoading,
    secretVisible,
  };
}
