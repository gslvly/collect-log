import { defineStore } from 'pinia';

import { getFieldTypes, type FieldTypesResponse } from '../api/field-types.js';
import { getApiErrorMessage } from '../api/errors.js';

let pendingLoad: Promise<void> | null = null;

interface FieldTypesState {
  response: FieldTypesResponse | null;
  loading: boolean;
  error: string;
}

export const useFieldTypesStore = defineStore('field-types', {
  state: (): FieldTypesState => ({
    response: null,
    loading: false,
    error: '',
  }),
  actions: {
    async load(): Promise<void> {
      if (this.response !== null) {
        return;
      }
      if (pendingLoad !== null) {
        return pendingLoad;
      }

      this.loading = true;
      this.error = '';
      pendingLoad = getFieldTypes()
        .then((response) => {
          this.response = response;
        })
        .catch((error: unknown) => {
          this.error = getApiErrorMessage(error);
          throw error;
        })
        .finally(() => {
          this.loading = false;
          pendingLoad = null;
        });
      return pendingLoad;
    },
  },
});
