import type { ActiveField, TableDefinition } from '../tables/types.js';

export interface TimeRange {
  start: number;
  end: number;
}

export type LeafOperator =
  'eq' | 'neq' | 'in' | 'not_in' | 'contains' | 'not_contains' | 'is_null' | 'is_not_null';

export type Condition =
  | { op: 'and' | 'or'; conditions: Condition[] }
  | { field: string; op: LeafOperator; value?: string | string[] | boolean | undefined };

export type QueryOrder = 'asc' | 'desc';

export interface DetailQueryInput {
  range: TimeRange;
  filter?: Condition | undefined;
  limit: number;
  order: QueryOrder;
  cursor?: string | undefined;
}

export type StatisticsMetric = 'total' | 'trend' | 'unique' | 'group' | 'boolean_ratio';
export type TrendGranularity = 'minute' | 'hour' | 'day';

export interface StatisticsInput {
  range: TimeRange;
  filter?: Condition | undefined;
  tz: string;
  metric: StatisticsMetric;
  granularity?: TrendGranularity | undefined;
  field?: string | undefined;
  limit?: number | undefined;
}

export interface ExportInput {
  range: TimeRange;
  filter?: Condition | undefined;
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
