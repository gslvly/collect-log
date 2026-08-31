import type { ActiveField, TableDefinition } from '../tables/types.js';
import type { FieldMeasure, FieldOperator } from '../field-types.js';

export interface TimeRange {
  start: number;
  end: number;
}

export type LeafOperator = FieldOperator;

export type Condition =
  | { op: 'and' | 'or'; conditions: Condition[] }
  | {
      field: string;
      op: LeafOperator;
      value?: string | string[] | number | number[] | boolean | undefined;
    };

export type QueryOrder = 'asc' | 'desc';

export interface DetailQueryInput {
  range: TimeRange;
  filter?: Condition | undefined;
  includeFields: string[];
  limit: number;
  order: QueryOrder;
  cursor?: string | undefined;
}

export type TrendGranularity = 'minute' | 'hour' | 'day';

/** DESIGN 9.4.1：`_occurred_at` 是默认时间轴，业务时间轴是任意具备 `timeAxis` 能力的字段。 */
export const OCCURRED_AT_AXIS = '_occurred_at';

export interface StatisticsTimeDimension {
  kind: 'time';
  axis: string;
  granularity: TrendGranularity;
}

export interface StatisticsFieldDimension {
  kind: 'field';
  field: string;
  limit: number;
}

export type StatisticsDimension = StatisticsTimeDimension | StatisticsFieldDimension;

export interface StatisticsMeasure {
  fn: FieldMeasure;
  field?: string | undefined;
}

/** DESIGN 9.4：统计只有两个正交的轴，接口不再枚举固定组合。 */
export interface StatisticsInput {
  range: TimeRange;
  filter?: Condition | undefined;
  tz: string;
  dimension?: StatisticsDimension | undefined;
  measure: StatisticsMeasure;
}

export interface ExportInput {
  range: TimeRange;
  filter?: Condition | undefined;
  includeFields: string[];
  order: QueryOrder;
}

export interface QueryLimits {
  maxRangeDays: number;
  maxRows: number;
  maxConditions: number;
  maxNestingDepth: number;
  maxExecutionTimeSec: number;
  maxMemoryUsageBytes: number;
  maxConcurrent: number;
  defaultGroupLimit: number;
  maxGroupLimit: number;
}

export interface ExportLimits {
  maxRows: number;
  maxExecutionTimeSec: number;
  maxConcurrent: number;
}

export interface FilterSql {
  sql: string;
  params: Record<string, unknown>;
}

export interface QueryStatement {
  query: string;
  params: Record<string, unknown>;
}

export interface DetailRow extends Record<string, unknown> {
  _record_id: string;
  _occurred_at: string;
  _received_at: string;
  _schema_version: number;
}

export interface CursorPayload {
  at: number;
  id: string;
  fp: string;
}

export interface QueryContext {
  definition: TableDefinition;
  fields: readonly ActiveField[];
}
