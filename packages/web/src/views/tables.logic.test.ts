import { describe, expect, it } from 'vitest';

import {
  TABLE_STATUSES,
  type CollectionTable,
  type CreateFieldInput,
  type TableTemplate,
} from '../api/tables.js';
import {
  applyTableTemplate,
  filterAndSortTables,
  getTableStatusLabel,
  hasTemplateContentToOverwrite,
  TABLE_STATUS_LABELS,
  toCreateTableInput,
  validateCreateTableForm,
} from './tables.logic.js';

const sampleField: CreateFieldInput = {
  key: 'event_name',
  label: '事件名',
  type: 'string',
  required: true,
  description: '事件名称',
};

const sampleTemplate: TableTemplate = {
  sourceDisplayName: '订单事件',
  description: '下单链路埋点',
  fields: [sampleField],
};

const tables: CollectionTable[] = [
  {
    projectId: 'prj_alpha',
    displayName: 'Alpha',
    description: 'checkout events',
    status: 'active',
    schemaVersion: 1,
    createdBy: 'alice',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    projectId: 'prj_charlie',
    displayName: 'Charlie',
    description: 'archived events',
    status: 'archived',
    schemaVersion: 3,
    createdBy: 'carol',
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  },
  {
    projectId: 'prj_bravo',
    displayName: 'Bravo',
    description: 'failed checkout',
    status: 'failed',
    schemaVersion: 1,
    createdBy: 'bob',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
  },
];

describe('table status labels', () => {
  it('covers every status defined by the server contract', () => {
    expect(Object.keys(TABLE_STATUS_LABELS)).toEqual(TABLE_STATUSES);
    expect(TABLE_STATUSES.map(getTableStatusLabel)).toEqual([
      '创建中',
      '已启用',
      '已停用',
      '已归档',
      '失败',
    ]);
  });
});

describe('create table form logic', () => {
  it('copies template description and fields without replacing the new table name', () => {
    const mapped = applyTableTemplate(
      { displayName: '新表', description: '旧说明', fields: [] },
      sampleTemplate,
    );

    expect(mapped).toEqual({
      displayName: '新表',
      description: '下单链路埋点',
      fields: [sampleField],
    });
    mapped.fields[0]!.label = '已编辑';
    expect(sampleTemplate.fields[0]!.label).toBe('事件名');
    expect(mapped.displayName).not.toBe(sampleTemplate.sourceDisplayName);
  });

  it('detects edited content that a template would overwrite', () => {
    expect(hasTemplateContentToOverwrite({ description: '', fields: [] })).toBe(false);
    expect(hasTemplateContentToOverwrite({ description: '手工说明', fields: [] })).toBe(true);
    expect(hasTemplateContentToOverwrite({ description: '', fields: [sampleField] })).toBe(true);
  });

  it('rejects a blank table name, invalid or duplicate keys, and blank field labels', () => {
    const validation = validateCreateTableForm({
      displayName: '   ',
      description: '',
      fields: [
        { ...sampleField, key: 'EventName' },
        { ...sampleField, label: '第一个重复字段' },
        { ...sampleField, label: '   ' },
      ],
    });

    expect(validation.valid).toBe(false);
    expect(validation.displayName).toBeDefined();
    expect(validation.fields[0]?.key).toContain('小写字母');
    expect(validation.fields[1]?.key).toContain('不能重复');
    expect(validation.fields[2]?.key).toContain('不能重复');
    expect(validation.fields[2]?.label).toBeDefined();
  });

  it('does not hard-code a client-side field count limit', () => {
    const fields = Array.from({ length: 501 }, (_, index): CreateFieldInput => ({
      ...sampleField,
      key: `field_${index}`,
    }));

    expect(
      validateCreateTableForm({ displayName: '大字段表', description: '', fields }).valid,
    ).toBe(true);
  });

  it('trims required display values and emits only the normal create request body', () => {
    expect(
      toCreateTableInput({
        displayName: '  新表  ',
        description: '说明',
        fields: [{ ...sampleField, label: '  事件名  ' }],
      }),
    ).toEqual({
      displayName: '新表',
      description: '说明',
      fields: [sampleField],
    });
  });
});

describe('table list logic', () => {
  it('filters by status and search text on the client', () => {
    expect(filterAndSortTables(tables, 'ALICE', 'active', 'createdAtDesc')).toEqual([tables[0]]);
    expect(filterAndSortTables(tables, 'checkout', 'failed', 'createdAtDesc')).toEqual([tables[2]]);
  });

  it('sorts a copied result without mutating the API response order', () => {
    const originalOrder = tables.map((table) => table.projectId);

    expect(
      filterAndSortTables(tables, '', 'all', 'createdAtDesc').map((table) => table.projectId),
    ).toEqual(['prj_bravo', 'prj_charlie', 'prj_alpha']);
    expect(
      filterAndSortTables(tables, '', 'all', 'displayNameAsc').map((table) => table.projectId),
    ).toEqual(['prj_alpha', 'prj_bravo', 'prj_charlie']);
    expect(tables.map((table) => table.projectId)).toEqual(originalOrder);
  });
});
