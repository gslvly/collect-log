import { computed, type ComputedRef, type Ref } from 'vue';

import type { CollectionField } from '../../api/tables.js';
import { useFieldTypesStore } from '../../stores/field-types.js';
import {
  HIGH_CARDINALITY_NOTICE,
  getGroupableFieldOptions,
  getMeasureFieldOptions,
  getMeasureOptions,
  getTimeAxisOptions,
  measureRequiresField,
  type StatisticsDraft,
} from './statistics.logic.js';

export function useStatisticsOptions(
  queryableFields: ComputedRef<CollectionField[]>,
  draft: Ref<StatisticsDraft>,
  resetResult: () => void,
) {
  const fieldTypesStore = useFieldTypesStore();
  const dimensionFieldOptions = computed(() =>
    getGroupableFieldOptions(queryableFields.value, fieldTypesStore.response),
  );
  const timeAxisOptions = computed(() =>
    getTimeAxisOptions(queryableFields.value, fieldTypesStore.response),
  );
  const measureOptions = computed(() => getMeasureOptions(fieldTypesStore.response));
  const measureFieldOptions = computed(() =>
    getMeasureFieldOptions(draft.value.fn, queryableFields.value, fieldTypesStore.response),
  );
  const fnNeedsField = computed(() =>
    measureRequiresField(draft.value.fn, fieldTypesStore.response),
  );
  const defaultGroupLimit = computed(
    () => fieldTypesStore.response?.limits.defaultGroupLimit ?? null,
  );
  const selectedDimensionField = computed(() =>
    queryableFields.value.find((field) => field.key === draft.value.dimensionField),
  );
  const measureLabel = computed(() => {
    const option = measureOptions.value.find((candidate) => candidate.fn === draft.value.fn);
    const base = option?.label ?? draft.value.fn;
    return fnNeedsField.value && draft.value.measureField !== ''
      ? `${base}（${draft.value.measureField}）`
      : base;
  });
  const highCardinalityNotice = computed(() =>
    draft.value.dimensionKind === 'field' && selectedDimensionField.value?.type === 'string'
      ? HIGH_CARDINALITY_NOTICE
      : '',
  );

  function onMeasureChange(): void {
    const stillValid = measureFieldOptions.value.some(
      (option) => option.key === draft.value.measureField,
    );
    if (!fnNeedsField.value || !stillValid) {
      draft.value.measureField = fnNeedsField.value
        ? (measureFieldOptions.value[0]?.key ?? '')
        : '';
    }
    resetResult();
  }

  function onDimensionKindChange(): void {
    if (draft.value.dimensionKind === 'field' && draft.value.dimensionField === '') {
      draft.value.dimensionField = dimensionFieldOptions.value[0]?.key ?? '';
    }
    resetResult();
  }

  return {
    defaultGroupLimit,
    dimensionFieldOptions,
    fnNeedsField,
    highCardinalityNotice,
    measureFieldOptions,
    measureLabel,
    measureOptions,
    onDimensionKindChange,
    onMeasureChange,
    selectedDimensionField,
    timeAxisOptions,
  };
}
