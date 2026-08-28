import { AppError } from '../../errors.js';
import { assertValidFieldKey } from '../tables/schema.js';
import type { ActiveField } from '../tables/types.js';
import type { Condition, FilterSql, QueryLimits } from './types.js';

interface FilterBuildState {
  conditionCount: number;
  parameterIndex: number;
  params: Record<string, unknown>;
}

const STRING_OPERATORS = new Set([
  'eq',
  'neq',
  'in',
  'not_in',
  'contains',
  'not_contains',
  'is_null',
  'is_not_null',
]);
const BOOLEAN_OPERATORS = new Set(['eq', 'is_null', 'is_not_null']);

function invalidQuery(message: string): never {
  throw new AppError('INVALID_QUERY', message);
}

function parameter(state: FilterBuildState, value: unknown, type: 'String' | 'Bool'): string {
  const name = `p${state.parameterIndex}`;
  state.parameterIndex += 1;
  state.params[name] = value;
  return `{${name}:${type}}`;
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

function buildStringLeaf(
  condition: Extract<Condition, { field: string }>,
  safeField: string,
  state: FilterBuildState,
  limits: QueryLimits,
): string {
  const column = `\`${safeField}\``;
  switch (condition.op) {
    case 'eq': {
      if (typeof condition.value !== 'string') {
        return invalidQuery(`Operator "eq" requires a string value for field "${safeField}"`);
      }
      addConditionCost(state, 1, limits);
      return `${column} = ${parameter(state, condition.value, 'String')}`;
    }
    case 'neq': {
      if (typeof condition.value !== 'string') {
        return invalidQuery(`Operator "neq" requires a string value for field "${safeField}"`);
      }
      addConditionCost(state, 1, limits);
      return `(${column} IS NULL OR ${column} != ${parameter(state, condition.value, 'String')})`;
    }
    case 'in':
    case 'not_in': {
      if (
        !Array.isArray(condition.value) ||
        condition.value.length === 0 ||
        !condition.value.every((value) => typeof value === 'string')
      ) {
        return invalidQuery(
          `Operator "${condition.op}" requires a non-empty string array for field "${safeField}"`,
        );
      }
      addConditionCost(state, condition.value.length, limits);
      const values = condition.value.map((value) => parameter(state, value, 'String')).join(', ');
      if (condition.op === 'not_in') {
        return `(${column} IS NULL OR ${column} NOT IN (${values}))`;
      }
      return `${column} IN (${values})`;
    }
    case 'contains': {
      if (typeof condition.value !== 'string') {
        return invalidQuery(`Operator "contains" requires a string value for field "${safeField}"`);
      }
      addConditionCost(state, 1, limits);
      return `position(${column}, ${parameter(state, condition.value, 'String')}) > 0`;
    }
    case 'not_contains': {
      if (typeof condition.value !== 'string') {
        return invalidQuery(
          `Operator "not_contains" requires a string value for field "${safeField}"`,
        );
      }
      addConditionCost(state, 1, limits);
      return `(${column} IS NULL OR position(${column}, ${parameter(
        state,
        condition.value,
        'String',
      )}) = 0)`;
    }
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

function buildBooleanLeaf(
  condition: Extract<Condition, { field: string }>,
  safeField: string,
  state: FilterBuildState,
  limits: QueryLimits,
): string {
  const column = `\`${safeField}\``;
  if (!BOOLEAN_OPERATORS.has(condition.op)) {
    return invalidQuery(
      `Operator "${condition.op}" is not supported for boolean field "${safeField}"`,
    );
  }
  switch (condition.op) {
    case 'eq':
      if (typeof condition.value !== 'boolean') {
        return invalidQuery(`Operator "eq" requires a boolean value for field "${safeField}"`);
      }
      addConditionCost(state, 1, limits);
      return `${column} = ${parameter(state, condition.value, 'Bool')}`;
    case 'is_null':
      assertNoValue(condition);
      addConditionCost(state, 1, limits);
      return `${column} IS NULL`;
    case 'is_not_null':
      assertNoValue(condition);
      addConditionCost(state, 1, limits);
      return `${column} IS NOT NULL`;
    default:
      return invalidQuery(
        `Operator "${condition.op}" is not supported for boolean field "${safeField}"`,
      );
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
  if (field.type === 'string') {
    if (!STRING_OPERATORS.has(condition.op)) {
      return invalidQuery(
        `Operator "${condition.op}" is not supported for string field "${field.key}"`,
      );
    }
    return buildStringLeaf(condition, field.key, state, limits);
  }
  return buildBooleanLeaf(condition, field.key, state, limits);
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
