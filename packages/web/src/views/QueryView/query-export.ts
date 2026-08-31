import { ElMessage } from 'element-plus';
import { ref, type Ref } from 'vue';

import { FileSystemExportUnavailableError } from '../../api/client.js';
import { getApiErrorMessage } from '../../api/errors.js';
import { exportTableRows, type ExportInput } from '../../api/query.js';

export function useQueryExport(
  projectId: Ref<string>,
  buildInput: () => ExportInput | null,
): { exportLoading: Ref<boolean>; handleExport: () => Promise<void> } {
  const exportLoading = ref(false);

  async function handleExport(): Promise<void> {
    const input = buildInput();
    if (input === null) {
      return;
    }
    exportLoading.value = true;
    try {
      const result = await exportTableRows(projectId.value, input);
      if (result.status === 'cancelled') {
        return;
      }
      if (result.status === 'truncated') {
        ElMessage.warning(`CSV 已保存并按服务端上限截断：${result.filename}`);
      } else {
        ElMessage.success(`CSV 已保存：${result.filename}`);
      }
    } catch (error) {
      ElMessage.error(
        error instanceof FileSystemExportUnavailableError
          ? error.message
          : getApiErrorMessage(error),
      );
    } finally {
      exportLoading.value = false;
    }
  }

  return { exportLoading, handleExport };
}
