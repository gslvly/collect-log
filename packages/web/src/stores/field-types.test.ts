import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FieldTypesResponse } from '../api/field-types.js';
import { pinia } from './index.js';
import { useFieldTypesStore } from './field-types.js';

const response: FieldTypesResponse = {
  types: [
    {
      type: 'float',
      label: '小数',
      capabilities: ['ordered', 'summable'],
      operators: ['gt', 'gte', 'lt', 'lte', 'is_null', 'is_not_null'],
      measures: ['min', 'max', 'sum', 'avg', 'p50', 'p90', 'p99'],
    },
  ],
  operators: [{ op: 'gt', label: '大于', arity: 'one' }],
  measures: [{ fn: 'sum', label: '合计' }],
  limits: {
    maxStringLength: 8_192,
    datetimeMinMs: 946_684_800_000,
    datetimeMaxMs: 4_102_444_800_000,
    maxEnumOptions: 200,
    maxOptionValueBytes: 64,
    maxOptionLabelBytes: 128,
    maxConditions: 32,
    maxNestingDepth: 4,
    maxRangeDays: 92,
    defaultGroupLimit: 50,
    maxGroupLimit: 1_000,
  },
};

describe('field type capability store', () => {
  beforeEach(() => {
    useFieldTypesStore(pinia).$reset();
    vi.restoreAllMocks();
  });

  it('loads the server matrix once and reuses it across page consumers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = useFieldTypesStore(pinia);

    await Promise.all([store.load(), store.load()]);
    await store.load();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/field-types',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(store.response).toEqual(response);
    expect(store.response?.limits.maxStringLength).toBe(8_192);
  });
});
