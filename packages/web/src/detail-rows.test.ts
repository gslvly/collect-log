import { describe, expect, it, vi } from 'vitest';

import type { CollectionField } from './api/tables.js';
import { formatCellValue, getCellKind, getColumnLabel, getColumnWidth } from './detail-rows.js';

const fields: CollectionField[] = [
  {
    key: 'event_name',
    label: '事件名',
    type: 'string',
    required: false,
    description: '',
    options: [],
    status: 'active',
    renamedTo: '',
    schemaVersion: 1,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
  },
];

describe('detail row rendering', () => {
  it('labels system, business, and unknown columns consistently', () => {
    expect(getColumnLabel('_record_id', fields)).toBe('记录 ID');
    expect(getColumnLabel('event_name', fields)).toBe('事件名');
    expect(getColumnLabel('unknown', fields)).toBe('unknown');
  });

  it('keeps null, empty strings, and boolean values visibly distinct', () => {
    expect(getCellKind(null)).toBe('unset');
    expect(getCellKind(undefined)).toBe('unset');
    expect(getCellKind('')).toBe('empty-string');
    expect(getCellKind(true)).toBe('boolean-true');
    expect(getCellKind(false)).toBe('boolean-false');

    expect(formatCellValue(null, 'event_name', String)).toBe('未提交');
    expect(formatCellValue('', 'event_name', String)).toBe('空字符串');
    expect(formatCellValue(true, 'event_name', String)).toBe('true');
    expect(formatCellValue(false, 'event_name', String)).toBe('false');
    expect(formatCellValue(0, 'event_name', String)).toBe('0');
  });

  it('formats UTC system timestamps and stringifies other values', () => {
    const formatUtc = vi.fn().mockReturnValue('本地时间');
    expect(formatCellValue('2026-08-29T00:00:00.000Z', '_occurred_at', formatUtc)).toBe('本地时间');
    expect(formatUtc).toHaveBeenCalledWith('2026-08-29T00:00:00.000Z');
    expect(formatCellValue({ nested: true }, 'event_name', formatUtc)).toBe('{"nested":true}');
  });

  it('uses stable widths for identifiers, timestamps, and business columns', () => {
    expect(getColumnWidth('_record_id')).toBe(310);
    expect(getColumnWidth('_occurred_at')).toBe(190);
    expect(getColumnWidth('_received_at')).toBe(190);
    expect(getColumnWidth('event_name')).toBe(160);
  });
});
