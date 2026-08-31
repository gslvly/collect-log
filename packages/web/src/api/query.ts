import { downloadExport, type DownloadExportResult } from './client.js';
import { requestJson } from './client.js';
import type { FieldMeasure, FieldOperator } from './field-types.js';

export interface TimeRange {
  start: number;
  end: number;
}

export type LeafOperator = FieldOperator;

export type QueryFilter =
  | { op: 'and' | 'or'; conditions: QueryFilter[] }
  | { field: string; op: LeafOperator; value?: string | string[] | number | number[] | boolean };

export type QueryOrder = 'asc' | 'desc';

export interface DetailQueryInput {
  range: TimeRange;
  filter?: QueryFilter;
  includeFields?: string[];
  limit?: number;
  order?: QueryOrder;
  cursor?: string;
}

export interface DetailRow extends Record<string, unknown> {
  _record_id: string;
  _occurred_at: string;
  _received_at: string;
  _schema_version: number;
}

export interface DetailQueryResponse {
  rows: DetailRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type TrendGranularity = 'minute' | 'hour' | 'day';

/** DESIGN 9.4.1：`_occurred_at` 是默认时间轴。 */
export const OCCURRED_AT_AXIS = '_occurred_at';

export type StatisticsDimensionInput =
  | { kind: 'time'; axis: string; granularity: TrendGranularity }
  | { kind: 'field'; field: string; limit?: number };

export interface StatisticsMeasureInput {
  fn: FieldMeasure;
  field?: string;
}

/** DESIGN 9.4：dimension × measure 两轴模型，`dimension` 省略即不分组。 */
export interface StatisticsInput {
  range: TimeRange;
  filter?: QueryFilter;
  tz: string;
  dimension?: StatisticsDimensionInput;
  measure: StatisticsMeasureInput;
}

export type StatisticsKey = string | number | boolean | null;
export type StatisticsValue = number | string | null;

export interface StatisticsRow {
  /** 时间维度是桶起点的 ISO 8601 UTC 串，字段维度是该字段的取值，不分组时缺席。 */
  key?: StatisticsKey;
  value: StatisticsValue;
  rows: number;
  /** 仅 `fn = count` 时给出。 */
  share?: number;
}

export interface StatisticsResponse {
  dimension: 'time' | 'field' | null;
  measure: StatisticsMeasureInput;
  rows: StatisticsRow[];
  totals: { value: StatisticsValue; rows: number };
  /** 仅 `fn ∈ {count, sum}` 且按字段分组时给出（DESIGN 9.4.4）。 */
  others?: { value: number };
  truncated: boolean;
  /** 仅时间轴是业务字段时出现（DESIGN 9.4.3 第四条）。 */
  nullAxisRows?: number;
}

export interface ExportInput {
  range: TimeRange;
  filter?: QueryFilter;
  includeFields?: string[];
  order?: QueryOrder;
}

export function getExportFilename(projectId: string, now = Date.now()): string {
  const timestamp = new Date(now).toISOString().replaceAll(/\D/g, '').slice(0, 14);
  return `collect_${projectId}_${timestamp}.csv`;
}

function queryPath(projectId: string): string {
  return `/api/admin/tables/${encodeURIComponent(projectId)}`;
}

export function queryTableRows(
  projectId: string,
  input: DetailQueryInput,
): Promise<DetailQueryResponse> {
  return requestJson<DetailQueryResponse>(`${queryPath(projectId)}/query`, {
    method: 'POST',
    body: input,
  });
}

export function getTableStatistics(
  projectId: string,
  input: StatisticsInput,
): Promise<StatisticsResponse> {
  return requestJson<StatisticsResponse>(`${queryPath(projectId)}/statistics`, {
    method: 'POST',
    body: input,
  });
}

export function exportTableRows(
  projectId: string,
  input: ExportInput,
): Promise<DownloadExportResult> {
  return downloadExport(`${queryPath(projectId)}/export`, {
    body: input,
    filename: getExportFilename(projectId),
  });
}
