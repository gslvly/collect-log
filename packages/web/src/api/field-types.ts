import type { FieldType } from './tables.js';
import { requestJson } from './client.js';

export type FieldCapability =
  | 'equatable'
  | 'enumerable'
  | 'ordered'
  | 'textual'
  | 'groupable'
  | 'uniquable'
  | 'summable'
  | 'timeAxis';

export type FieldOperator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'not_in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'not_contains'
  | 'is_empty'
  | 'is_not_empty'
  | 'is_null'
  | 'is_not_null';

export type OperatorArity = 'none' | 'one' | 'many';

export type FieldMeasure =
  'count' | 'unique' | 'min' | 'max' | 'sum' | 'avg' | 'p50' | 'p90' | 'p99';

export interface FieldTypeDefinition {
  type: FieldType;
  label: string;
  capabilities: FieldCapability[];
  operators: FieldOperator[];
  measures: FieldMeasure[];
}

export interface FieldOperatorDefinition {
  op: FieldOperator;
  label: string;
  arity: OperatorArity;
}

export interface FieldMeasureDefinition {
  fn: FieldMeasure;
  label: string;
}

export interface FieldTypeLimits {
  maxStringLength: number;
  datetimeMinMs: number;
  datetimeMaxMs: number;
  maxEnumOptions: number;
  maxOptionValueBytes: number;
  maxOptionLabelBytes: number;
  maxConditions: number;
  maxNestingDepth: number;
  maxRangeDays: number;
  defaultGroupLimit: number;
  maxGroupLimit: number;
}

export interface FieldTypesResponse {
  types: FieldTypeDefinition[];
  operators: FieldOperatorDefinition[];
  measures: FieldMeasureDefinition[];
  limits: FieldTypeLimits;
}

export function getFieldTypes(): Promise<FieldTypesResponse> {
  return requestJson<FieldTypesResponse>('/api/admin/field-types');
}
