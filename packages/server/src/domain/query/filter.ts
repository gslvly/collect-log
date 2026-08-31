import { configuredLimits } from '../../config/limits.js';
import { AppError } from '../../errors.js';
import { fieldTypeSupportsOperator, type FieldOperator } from '../field-types.js';
import { formatOccurredAt } from '../ingest/writer.js';
import { assertValidFieldKey } from '../tables/schema.js';
import type { ActiveField, FieldType } from '../tables/types.js';
import type { Condition, FilterSql, QueryLimits } from './types.js';

interface FilterBuildState {
  conditionCount: number;
  parameterIndex: number;
  params: Record<string, unknown>;
}

type ParameterType = 'String' | 'Bool' | 'Int64' | 'Float64' | "DateTime64(3, 'UTC')";

function invalidQuery(message: string): never {
  throw new AppError('INVALID_QUERY', message);
}

function parameter(state: FilterBuildState, value: unknown, type: ParameterType): string {
  const name = `p${state.parameterIndex}`;
  state.parameterIndex += 1;
  state.params[name] = value;
  return `{${name}:${type}}`;
}

function isValidScalar(value: unknown, fieldType: FieldType): value is string | number | boolean {
  if (fieldType === 'string' || fieldType === 'enum') {
    return typeof value === 'string';
  }
  if (fieldType === 'boolean') {
    return typeof value === 'boolean';
  }
  if (fieldType === 'integer') {
    return Number.isSafeInteger(value);
  }
  if (fieldType === 'float') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= configuredLimits.ingest.datetimeMinMs &&
    value <= configuredLimits.ingest.datetimeMaxMs
  );
}

function fieldParameter(
  state: FilterBuildState,
  value: string | number | boolean,
  fieldType: FieldType,
): string {
  if (fieldType === 'string' || fieldType === 'enum') {
    return parameter(state, value, 'String');
  }
  if (fieldType === 'boolean') {
    return parameter(state, value, 'Bool');
  }
  if (fieldType === 'integer') {
    return parameter(state, value, 'Int64');
  }
  if (fieldType === 'datetime') {
    return parameter(state, formatOccurredAt(value as number), "DateTime64(3, 'UTC')");
  }
  return parameter(state, value, 'Float64');
}

function requireField(fieldKey: string, fields: ReadonlyMap<string, ActiveField>): ActiveField {
  if (fieldKey.startsWith('_')) {
    return invalidQuery(`Unknown field "${fieldKey}"`);
  }
  const field = fields.get(fieldKey);
  if (field === undefined) {
    return invalidQuery(`Unknown field "${fieldKey}"`);
  }
  assertValidFieldKey(field.key);
  return field;
}

function addConditionCost(state: FilterBuildState, cost: number, limits: QueryLimits): void {
  state.conditionCount += cost;
  if (state.conditionCount > limits.maxConditions) {
    invalidQuery(`Filter must not exceed ${limits.maxConditions} conditions`);
  }
}

function assertNoValue(condition: Extract<Condition, { field: string }>): void {
  if (condition.value !== undefined) {
    invalidQuery(`Operator "${condition.op}" does not accept a value`);
  }
}

function scalarValue(
  condition: Extract<Condition, { field: string }>,
  field: ActiveField,
): string | number | boolean {
  if (!isValidScalar(condition.value, field.type)) {
    return invalidQuery(
      `Operator "${condition.op}" requires a valid ${field.type} value for field "${field.key}"`,
    );
  }
  return condition.value;
}

function scalarArray(
  condition: Extract<Condition, { field: string }>,
  field: ActiveField,
): Array<string | number | boolean> {
  if (
    !Array.isArray(condition.value) ||
    condition.value.length === 0 ||
    !condition.value.every((value) => isValidScalar(value, field.type))
  ) {
    return invalidQuery(
      `Operator "${condition.op}" requires a non-empty ${field.type} array for field "${field.key}"`,
    );
  }
  return condition.value;
}

function buildLeaf(
  condition: Extract<Condition, { field: string }>,
  field: ActiveField,
  state: FilterBuildState,
  limits: QueryLimits,
): string {
  const column = `\`${field.key}\``;
  const operator: FieldOperator = condition.op;
  if (!fieldTypeSupportsOperator(field.type, operator)) {
    return invalidQuery(
      `Operator "${operator}" is not supported for ${field.type} field "${field.key}"`,
    );
  }

  switch (operator) {
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const value = scalarValue(condition, field);
      addConditionCost(state, 1, limits);
      const comparison = {
        eq: '=',
        neq: '!=',
        gt: '>',
        gte: '>=',
        lt: '<',
        lte: '<=',
      }[operator];
      const expression = `${column} ${comparison} ${fieldParameter(state, value, field.type)}`;
      return operator === 'neq' ? `(${column} IS NULL OR ${expression})` : expression;
    }
    case 'in':
    case 'not_in': {
      const values = scalarArray(condition, field);
      addConditionCost(state, values.length, limits);
      const parameters = values.map((value) => fieldParameter(state, value, field.type)).join(', ');
      return operator === 'not_in'
        ? `(${column} IS NULL OR ${column} NOT IN (${parameters}))`
        : `${column} IN (${parameters})`;
    }
    case 'contains':
    case 'not_contains': {
      const value = scalarValue(condition, field);
      addConditionCost(state, 1, limits);
      const expression = `position(${column}, ${fieldParameter(state, value, field.type)})`;
      return operator === 'not_contains'
        ? `(${column} IS NULL OR ${expression} = 0)`
        : `${expression} > 0`;
    }
    case 'is_empty':
      assertNoValue(condition);
      addConditionCost(state, 1, limits);
      return `${column} = ''`;
    case 'is_not_empty':
      assertNoValue(condition);
      addConditionCost(state, 1, limits);
      return `(${column} IS NOT NULL AND ${column} != '')`;
    case 'is_null':
      assertNoValue(condition);
      addConditionCost(state, 1, limits);
      return `${column} IS NULL`;
    case 'is_not_null':
      assertNoValue(condition);
      addConditionCost(state, 1, limits);
      return `${column} IS NOT NULL`;
  }
}

function buildCondition(
  condition: Condition,
  fields: ReadonlyMap<string, ActiveField>,
  state: FilterBuildState,
  limits: QueryLimits,
  depth: number,
): string {
  if (depth > limits.maxNestingDepth) {
    return invalidQuery(`Filter nesting depth must not exceed ${limits.maxNestingDepth}`);
  }

  if ('conditions' in condition) {
    if (condition.conditions.length === 0) {
      return invalidQuery(`Operator "${condition.op}" requires at least one condition`);
    }
    const operator = condition.op === 'and' ? ' AND ' : ' OR ';
    return `(${condition.conditions
      .map((child) => buildCondition(child, fields, state, limits, depth + 1))
      .join(operator)})`;
  }

  const field = requireField(condition.field, fields);
  return buildLeaf(condition, field, state, limits);
}

export function buildFilterSql(
  condition: Condition | undefined,
  activeFields: readonly ActiveField[],
  limits: QueryLimits,
): FilterSql {
  if (condition === undefined) {
    return { sql: '', params: {} };
  }
  const fields = new Map(activeFields.map((field) => [field.key, field]));
  const state: FilterBuildState = { conditionCount: 0, parameterIndex: 0, params: {} };
  const sql = buildCondition(condition, fields, state, limits, 1);
  return { sql, params: state.params };
}
