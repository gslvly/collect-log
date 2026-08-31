import type { FastifyInstance } from 'fastify';

import { configuredLimits } from '../config/limits.js';
import { requireRole } from './auth/jwt.js';
import { FIELD_TYPES, type FieldType } from './tables/types.js';

export const FIELD_CAPABILITIES = [
  'equatable',
  'enumerable',
  'ordered',
  'textual',
  'groupable',
  'uniquable',
  'summable',
  'timeAxis',
] as const;

export type FieldCapability = (typeof FIELD_CAPABILITIES)[number];

export const FIELD_OPERATORS = [
  'eq',
  'neq',
  'in',
  'not_in',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'not_contains',
  'is_empty',
  'is_not_empty',
  'is_null',
  'is_not_null',
] as const;

export type FieldOperator = (typeof FIELD_OPERATORS)[number];
export type OperatorArity = 'none' | 'one' | 'many';

export const FIELD_MEASURES = [
  'count',
  'unique',
  'min',
  'max',
  'sum',
  'avg',
  'p50',
  'p90',
  'p99',
] as const;

export type FieldMeasure = (typeof FIELD_MEASURES)[number];

interface OperatorDefinition {
  op: FieldOperator;
  label: string;
  arity: OperatorArity;
  capability?: FieldCapability;
}

interface MeasureDefinition {
  fn: FieldMeasure;
  label: string;
  capability?: FieldCapability;
}

const CAPABILITIES_BY_TYPE = {
  string: ['equatable', 'enumerable', 'textual', 'groupable', 'uniquable'],
  enum: ['equatable', 'enumerable', 'groupable', 'uniquable'],
  boolean: ['equatable', 'groupable'],
  integer: ['equatable', 'enumerable', 'ordered', 'groupable', 'uniquable', 'summable'],
  float: ['ordered', 'summable'],
  datetime: ['ordered', 'timeAxis'],
} as const satisfies Record<FieldType, readonly FieldCapability[]>;

export const OPERATOR_DEFINITIONS: readonly OperatorDefinition[] = [
  { op: 'eq', label: '等于', arity: 'one', capability: 'equatable' },
  { op: 'neq', label: '不等于', arity: 'one', capability: 'equatable' },
  { op: 'in', label: '属于', arity: 'many', capability: 'enumerable' },
  { op: 'not_in', label: '不属于', arity: 'many', capability: 'enumerable' },
  { op: 'gt', label: '大于', arity: 'one', capability: 'ordered' },
  { op: 'gte', label: '大于等于', arity: 'one', capability: 'ordered' },
  { op: 'lt', label: '小于', arity: 'one', capability: 'ordered' },
  { op: 'lte', label: '小于等于', arity: 'one', capability: 'ordered' },
  { op: 'contains', label: '包含', arity: 'one', capability: 'textual' },
  { op: 'not_contains', label: '不包含', arity: 'one', capability: 'textual' },
  { op: 'is_empty', label: '空字符串', arity: 'none', capability: 'textual' },
  { op: 'is_not_empty', label: '非空字符串', arity: 'none', capability: 'textual' },
  { op: 'is_null', label: '未提交', arity: 'none' },
  { op: 'is_not_null', label: '已提交', arity: 'none' },
];

export const MEASURE_DEFINITIONS: readonly MeasureDefinition[] = [
  { fn: 'count', label: '记录数' },
  { fn: 'unique', label: '去重计数', capability: 'uniquable' },
  { fn: 'min', label: '最小值', capability: 'ordered' },
  { fn: 'max', label: '最大值', capability: 'ordered' },
  { fn: 'sum', label: '合计', capability: 'summable' },
  { fn: 'avg', label: '平均值', capability: 'summable' },
  { fn: 'p50', label: 'P50', capability: 'summable' },
  { fn: 'p90', label: 'P90', capability: 'summable' },
  { fn: 'p99', label: 'P99', capability: 'summable' },
];

const TYPE_LABELS = {
  string: '文本',
  enum: '枚举',
  boolean: '布尔',
  integer: '整数',
  float: '小数',
  datetime: '时间',
} as const satisfies Record<FieldType, string>;

export function fieldTypeHasCapability(type: FieldType, capability: FieldCapability): boolean {
  return (CAPABILITIES_BY_TYPE[type] as readonly FieldCapability[]).includes(capability);
}

export function operatorsForFieldType(type: FieldType): FieldOperator[] {
  return OPERATOR_DEFINITIONS.filter(
    (definition) =>
      definition.capability === undefined || fieldTypeHasCapability(type, definition.capability),
  ).map((definition) => definition.op);
}

export function measuresForFieldType(type: FieldType): FieldMeasure[] {
  return MEASURE_DEFINITIONS.filter(
    (definition) =>
      definition.capability !== undefined && fieldTypeHasCapability(type, definition.capability),
  ).map((definition) => definition.fn);
}

export function fieldTypeSupportsOperator(type: FieldType, operator: FieldOperator): boolean {
  return operatorsForFieldType(type).includes(operator);
}

/**
 * DESIGN 9.4.2：`count` 是不带 `field` 的表级度量，其余 `fn` 都要求一个字段并各自绑定一种能力。
 * `measuresForFieldType` 只列出「带能力」的那些，因此 `count` 对六种类型一律返回 false ——
 * 这正是 `count` 带了 `field` 必须回 INVALID_QUERY 的那条规则。
 */
export function fieldTypeSupportsMeasure(type: FieldType, measure: FieldMeasure): boolean {
  return measuresForFieldType(type).includes(measure);
}

export function measureRequiresField(measure: FieldMeasure): boolean {
  return MEASURE_DEFINITIONS.some(
    (definition) => definition.fn === measure && definition.capability !== undefined,
  );
}

export const fieldTypesResponse = {
  types: FIELD_TYPES.map((type) => ({
    type,
    label: TYPE_LABELS[type],
    capabilities: [...CAPABILITIES_BY_TYPE[type]],
    operators: operatorsForFieldType(type),
    measures: measuresForFieldType(type),
  })),
  operators: OPERATOR_DEFINITIONS.map(({ op, label, arity }) => ({ op, label, arity })),
  measures: MEASURE_DEFINITIONS.map(({ fn, label }) => ({ fn, label })),
  limits: {
    maxStringLength: configuredLimits.ingest.maxStringLength,
    datetimeMinMs: configuredLimits.ingest.datetimeMinMs,
    datetimeMaxMs: configuredLimits.ingest.datetimeMaxMs,
    maxEnumOptions: configuredLimits.schema.maxEnumOptions,
    maxOptionValueBytes: configuredLimits.schema.maxOptionValueBytes,
    maxOptionLabelBytes: configuredLimits.schema.maxOptionLabelBytes,
    // 附录 A 的 query 组：前端的条件构造器与统计页要按同一份限额自校验，
    // 否则调大配置之后前端会拦下服务端本可接受的查询。
    maxConditions: configuredLimits.query.maxConditions,
    maxNestingDepth: configuredLimits.query.maxNestingDepth,
    maxRangeDays: configuredLimits.query.maxRangeDays,
    defaultGroupLimit: configuredLimits.query.defaultGroupLimit,
    maxGroupLimit: configuredLimits.query.maxGroupLimit,
  },
} as const;

export function registerFieldTypeRoutes(app: FastifyInstance): void {
  app.get(
    '/api/admin/field-types',
    { preHandler: requireRole('user', 'admin', 'super_admin') },
    (_request, reply) => {
      void reply.header('cache-control', 'private, max-age=86400');
      return fieldTypesResponse;
    },
  );
}
