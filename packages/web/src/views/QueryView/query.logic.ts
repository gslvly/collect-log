import type { QueryFilter, QueryOrder, TimeRange } from '../../api/query.js';
import type {
  FieldOperator,
  FieldOperatorDefinition,
  FieldTypesResponse,
  OperatorArity,
} from '../../api/field-types.js';
import type { CollectionField, CollectionTable, FieldType, TableStatus } from '../../api/tables.js';

export {
  pickerDateToTimestamp,
  pickerRangeToTimeRange,
  timeRangeToPickerRange,
  timestampToPickerDate,
} from './query-time.logic.js';

export const QUERY_PAGE_SIZE = 100;

const DAY_MS = 86_400_000;

/**
 * 附录 A 的 `maxRangeDays` / `maxConditions` / `maxNestingDepth` 都是可配的，
 * 一律读 `GET /api/admin/field-types` 下发的 `limits`，前端不留副本。
 * 矩阵还没到手时统一失败关闭（提示「尚未加载」），不猜一个默认值放行。
 */
export type QueryLimitsSource = Pick<
  FieldTypesResponse['limits'],
  'maxRangeDays' | 'maxConditions' | 'maxNestingDepth'
>;

export interface FilterGroupDraft {
  id: string;
  kind: 'group';
  op: 'and' | 'or';
  conditions: FilterDraft[];
}

export interface FilterRuleDraft {
  id: string;
  kind: 'rule';
  field: string;
  op: LeafOperator;
  value?: string | string[] | number | number[] | boolean;
}

export type FilterDraft = FilterGroupDraft | FilterRuleDraft;

export type LeafOperator = FieldOperator;

export type OperatorOption = FieldOperatorDefinition;

export interface FilterBuildResult {
  valid: boolean;
  count: number;
  filter?: QueryFilter;
  message?: string;
}

export interface ColumnPreference {
  order: string[];
  hidden: string[];
}

let draftSequence = 0;

function nextDraftId(): string {
  draftSequence += 1;
  return `filter-${draftSequence}`;
}

export function getQueryableTables(tables: readonly CollectionTable[]): CollectionTable[] {
  return tables.filter((table) => table.status !== 'creating' && table.status !== 'failed');
}

export function createDefaultTimeRange(now = Date.now()): TimeRange {
  return { start: now - DAY_MS, end: now };
}

export function validateTimeRange(
  range: TimeRange | null,
  limits: QueryLimitsSource | null,
): string | undefined {
  if (range === null || !Number.isFinite(range.start) || !Number.isFinite(range.end)) {
    return '请选择时间范围';
  }
  if (range.start >= range.end) {
    return '开始时间必须早于结束时间';
  }
  if (limits === null) {
    return '查询限额尚未加载';
  }
  if (range.end - range.start > limits.maxRangeDays * DAY_MS) {
    return `时间跨度不能超过 ${limits.maxRangeDays} 天`;
  }
  return undefined;
}

export function createFilterGroup(op: 'and' | 'or' = 'and'): FilterGroupDraft {
  return { id: nextDraftId(), kind: 'group', op, conditions: [] };
}

export function createFilterRule(field = ''): FilterRuleDraft {
  return { id: nextDraftId(), kind: 'rule', field, op: 'eq', value: '' };
}

function defaultScalarValue(field: CollectionField): string | number | boolean | undefined {
  if (field.type === 'boolean') {
    return true;
  }
  if (field.type === 'integer' || field.type === 'float') {
    return 0;
  }
  if (field.type === 'datetime') {
    return undefined;
  }
  if (field.type === 'enum') {
    return field.options.find((option) => option.status === 'active')?.value ?? '';
  }
  return '';
}

function resetRuleValue(rule: FilterRuleDraft, field: CollectionField, arity: OperatorArity): void {
  if (arity === 'none') {
    delete rule.value;
    return;
  }
  const value = defaultScalarValue(field);
  if (arity === 'many') {
    if (typeof value === 'string') {
      rule.value = value === '' ? [] : [value];
    } else if (typeof value === 'number') {
      rule.value = [value];
    } else {
      rule.value = [];
    }
    return;
  }
  if (value === undefined) {
    delete rule.value;
  } else {
    rule.value = value;
  }
}

export function getOperatorOptions(
  fieldKey: string,
  fields: readonly CollectionField[],
  fieldTypes: FieldTypesResponse,
): FieldOperatorDefinition[] {
  const field = fields.find((candidate) => candidate.key === fieldKey);
  const typeDefinition = fieldTypes.types.find((candidate) => candidate.type === field?.type);
  if (typeDefinition === undefined) {
    return [];
  }
  const supported = new Set(typeDefinition.operators);
  return fieldTypes.operators.filter((operator) => supported.has(operator.op));
}

export function getOperatorArity(
  operator: LeafOperator,
  fieldTypes: FieldTypesResponse,
): OperatorArity | undefined {
  return fieldTypes.operators.find((candidate) => candidate.op === operator)?.arity;
}

export function resetRuleForField(
  rule: FilterRuleDraft,
  fields: readonly CollectionField[],
  fieldTypes: FieldTypesResponse,
): void {
  const field = fields.find((candidate) => candidate.key === rule.field);
  const operator = getOperatorOptions(rule.field, fields, fieldTypes)[0];
  if (field === undefined || operator === undefined) {
    delete rule.value;
    return;
  }
  rule.op = operator.op;
  resetRuleValue(rule, field, operator.arity);
}

export function setRuleOperator(
  rule: FilterRuleDraft,
  operator: LeafOperator,
  field: CollectionField,
  fieldTypes: FieldTypesResponse,
): void {
  rule.op = operator;
  const arity = getOperatorArity(operator, fieldTypes);
  if (arity === undefined) {
    delete rule.value;
    return;
  }
  resetRuleValue(rule, field, arity);
}

export function getFieldType(
  fieldKey: string,
  fields: readonly CollectionField[],
): FieldType | undefined {
  return fields.find((field) => field.key === fieldKey)?.type;
}

export function isNumericFieldType(type: FieldType | undefined): boolean {
  return type === 'integer' || type === 'float' || type === 'datetime';
}

function isValidFilterValue(
  value: unknown,
  field: CollectionField,
  fieldTypes: FieldTypesResponse,
): value is string | number | boolean {
  if (field.type === 'string' || field.type === 'enum') {
    return typeof value === 'string';
  }
  if (field.type === 'boolean') {
    return typeof value === 'boolean';
  }
  if (field.type === 'integer') {
    return Number.isSafeInteger(value);
  }
  if (field.type === 'float') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= fieldTypes.limits.datetimeMinMs &&
    value <= fieldTypes.limits.datetimeMaxMs
  );
}

function invalidFilter(count: number, message: string): FilterBuildResult {
  return { valid: false, count, message };
}

export function getConditionCount(node: FilterDraft): number {
  if (node.kind === 'group') {
    return node.conditions.reduce((total, child) => total + getConditionCount(child), 0);
  }
  if ((node.op === 'in' || node.op === 'not_in') && Array.isArray(node.value)) {
    return node.value.length;
  }
  return 1;
}

export function buildQueryFilter(
  root: FilterGroupDraft,
  fields: readonly CollectionField[],
  fieldTypes: FieldTypesResponse | null,
): FilterBuildResult {
  const count = getConditionCount(root);
  if (fieldTypes === null) {
    return count === 0 && root.conditions.length === 0
      ? { valid: true, count }
      : invalidFilter(count, '字段类型能力尚未加载');
  }
  const metadata = fieldTypes;
  const maxConditions = metadata.limits.maxConditions;
  if (count > maxConditions) {
    return invalidFilter(count, `条件数量不能超过 ${maxConditions}`);
  }
  if (root.conditions.length === 0) {
    return { valid: true, count };
  }

  const fieldsByKey = new Map(
    fields
      .filter((field) => field.status === 'active' || field.status === 'deprecated')
      .map((field) => [field.key, field]),
  );
  let error: string | undefined;

  function visit(node: FilterDraft, depth: number): QueryFilter | undefined {
    if (depth > metadata.limits.maxNestingDepth) {
      error = `嵌套深度不能超过 ${metadata.limits.maxNestingDepth}`;
      return undefined;
    }
    if (node.kind === 'group') {
      if (node.conditions.length === 0) {
        error = '条件组不能为空';
        return undefined;
      }
      const conditions: QueryFilter[] = [];
      for (const child of node.conditions) {
        const condition = visit(child, depth + 1);
        if (condition === undefined) {
          return undefined;
        }
        conditions.push(condition);
      }
      return { op: node.op, conditions };
    }

    const field = fieldsByKey.get(node.field);
    if (field === undefined) {
      error = '请选择可查询字段';
      return undefined;
    }
    const typeDefinition = metadata.types.find((candidate) => candidate.type === field.type);
    const operator = metadata.operators.find((candidate) => candidate.op === node.op);
    if (typeDefinition === undefined || operator === undefined) {
      error = `字段 ${field.key} 的类型能力不完整`;
      return undefined;
    }
    if (!typeDefinition.operators.includes(node.op)) {
      error = `${field.type} 字段 ${field.key} 不支持操作符 ${node.op}`;
      return undefined;
    }
    if (operator.arity === 'none') {
      return { field: field.key, op: node.op };
    }
    if (operator.arity === 'many') {
      if (
        !Array.isArray(node.value) ||
        node.value.length === 0 ||
        !node.value.every((value) => isValidFilterValue(value, field, metadata))
      ) {
        error = `字段 ${field.key} 至少需要一个合法值`;
        return undefined;
      }
      if (field.type === 'string' || field.type === 'enum') {
        return { field: field.key, op: node.op, value: [...(node.value as string[])] };
      }
      return { field: field.key, op: node.op, value: [...(node.value as number[])] };
    }
    if (!isValidFilterValue(node.value, field, metadata)) {
      error = `字段 ${field.key} 的条件值不符合 ${field.type} 类型要求`;
      return undefined;
    }
    return { field: field.key, op: node.op, value: node.value };
  }

  const filter = visit(root, 1);
  if (filter === undefined) {
    return invalidFilter(count, error ?? '查询条件不正确');
  }
  return { valid: true, count, filter };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return undefined;
  }
  return [...new Set(value)];
}

export function parseColumnPreference(value: string | null): ColumnPreference | null {
  if (value === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as { order?: unknown; hidden?: unknown };
    const order = stringArray(parsed.order);
    const hidden = stringArray(parsed.hidden);
    return order === undefined || hidden === undefined ? null : { order, hidden };
  } catch {
    return null;
  }
}

export function reconcileColumnPreference(
  serverColumns: readonly string[],
  stored: ColumnPreference | null,
): ColumnPreference {
  const available = [...new Set(serverColumns)];
  if (stored === null) {
    return { order: available, hidden: [] };
  }
  const availableSet = new Set(available);
  const remembered = stored.order.filter((column) => availableSet.has(column));
  const rememberedSet = new Set(remembered);
  return {
    order: [...remembered, ...available.filter((column) => !rememberedSet.has(column))],
    hidden: stored.hidden.filter((column) => availableSet.has(column)),
  };
}

export function moveColumn(order: readonly string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) {
    return [...order];
  }
  const result = [...order];
  const [moved] = result.splice(from, 1);
  if (moved !== undefined) {
    result.splice(to, 0, moved);
  }
  return result;
}

export function getResultColumns(rows: readonly Record<string, unknown>[]): string[] {
  return rows[0] === undefined ? [] : Object.keys(rows[0]);
}

export function columnStorageKey(projectId: string): string {
  return `collect-log.query.columns.${projectId}`;
}

export function isQueryTableReady(status: TableStatus): boolean {
  return status !== 'creating' && status !== 'failed';
}

export function queryInputSignature(input: {
  projectId: string;
  range: TimeRange | null;
  filter: FilterGroupDraft;
  includeFields: readonly string[];
  order: QueryOrder;
  schemaVersion: number | null;
}): string {
  return JSON.stringify({
    projectId: input.projectId,
    range: input.range,
    filter: input.filter,
    includeFields: [...input.includeFields].sort(),
    order: input.order,
    schemaVersion: input.schemaVersion,
  });
}
