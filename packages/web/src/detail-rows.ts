import type { CollectionField } from './api/tables.js';

export type CellKind = 'text' | 'empty-string' | 'unset' | 'boolean-true' | 'boolean-false';

const SYSTEM_COLUMN_LABELS: Readonly<Record<string, string>> = {
  _record_id: '记录 ID',
  _occurred_at: '发生时间',
  _received_at: '接收时间',
  _schema_version: 'Schema 版本',
};

export function getColumnLabel(column: string, fields: readonly CollectionField[]): string {
  const field = fields.find((candidate) => candidate.key === column);
  return SYSTEM_COLUMN_LABELS[column] ?? field?.label ?? column;
}

export function getCellKind(value: unknown): CellKind {
  if (value === null || value === undefined) {
    return 'unset';
  }
  if (value === true) {
    return 'boolean-true';
  }
  if (value === false) {
    return 'boolean-false';
  }
  if (value === '') {
    return 'empty-string';
  }
  return 'text';
}

export function formatCellValue(
  value: unknown,
  column: string,
  formatUtc: (value: string) => string,
): string {
  const kind = getCellKind(value);
  if (kind === 'unset') {
    return '未提交';
  }
  if (kind === 'boolean-true') {
    return 'true';
  }
  if (kind === 'boolean-false') {
    return 'false';
  }
  if (kind === 'empty-string') {
    return '空字符串';
  }
  if ((column === '_occurred_at' || column === '_received_at') && typeof value === 'string') {
    return formatUtc(value);
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function getColumnWidth(column: string): number {
  if (column === '_record_id') {
    return 310;
  }
  if (column === '_occurred_at' || column === '_received_at') {
    return 190;
  }
  return 160;
}
