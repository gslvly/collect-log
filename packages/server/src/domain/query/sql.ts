import { AppError } from '../../errors.js';
import { assertIdentifier } from '../../infra/clickhouse.js';
import {
  fieldTypeHasCapability,
  fieldTypeSupportsMeasure,
  type FieldCapability,
  type FieldMeasure,
} from '../field-types.js';
import { formatOccurredAt } from '../ingest/writer.js';
import { assertValidFieldKey } from '../tables/schema.js';
import type { ActiveField, TableDefinition } from '../tables/types.js';
import { decodeCursor, queryFingerprint } from './cursor.js';
import {
  OCCURRED_AT_AXIS,
  type DetailQueryInput,
  type ExportInput,
  type FilterSql,
  type QueryStatement,
  type StatisticsInput,
  type StatisticsMeasure,
  type TrendGranularity,
} from './types.js';

const SYSTEM_COLUMNS = ['_record_id', '_occurred_at', '_received_at', '_schema_version'] as const;

interface DetailStatement extends QueryStatement {
  fingerprint: string;
}

function invalidQuery(message: string): never {
  throw new AppError('INVALID_QUERY', message);
}

function physicalTable(definition: TableDefinition): string {
  return `data.${assertIdentifier(definition.physicalName)}`;
}

export function selectedColumns(activeFields: readonly ActiveField[]): string {
  const businessColumns = [...activeFields]
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((field) => `\`${assertValidFieldKey(field.key)}\``);
  return [...SYSTEM_COLUMNS.map((column) => `\`${column}\``), ...businessColumns].join(', ');
}

function rangeWhere(range: DetailQueryInput['range']): {
  clauses: string[];
  params: Record<string, unknown>;
} {
  // 参数类型必须写死 'UTC'：不带时区的 {x:DateTime64(3)} 会按 ClickHouse 的 session/server
  // 时区解析这里传入的 'YYYY-MM-DD HH:MM:SS.sss' 字符串。CH 配成 Asia/Shanghai 时
  // 整个时间范围会偏移 8 小时（已在本地实测）。物理列本身就是 DateTime64(3, 'UTC')。
  return {
    clauses: [
      "`_occurred_at` >= {start:DateTime64(3, 'UTC')}",
      "`_occurred_at` < {end:DateTime64(3, 'UTC')}",
    ],
    params: {
      start: formatOccurredAt(range.start),
      end: formatOccurredAt(range.end),
    },
  };
}

function filteredWhere(
  range: DetailQueryInput['range'],
  filter: FilterSql,
): { sql: string; params: Record<string, unknown> } {
  const result = rangeWhere(range);
  if (filter.sql !== '') {
    result.clauses.push(filter.sql);
  }
  return {
    sql: result.clauses.join('\n  AND '),
    params: { ...result.params, ...filter.params },
  };
}

/**
 * DESIGN 9.4：`dimension.field` / `measure.field` / `axis` 三处直接放行 `deprecated`
 * （`queryFields` 已经只含 active + deprecated），`dropped` / `renamed` / 未知字段
 * / `_` 开头的系统列一律 INVALID_QUERY。
 */
function requireStatisticsField(
  fieldKey: string,
  queryFields: readonly ActiveField[],
): ActiveField {
  if (fieldKey.startsWith('_')) {
    return invalidQuery(`Unknown field "${fieldKey}"`);
  }
  const field = queryFields.find((candidate) => candidate.key === fieldKey);
  if (field === undefined) {
    return invalidQuery(`Unknown field "${fieldKey}"`);
  }
  assertValidFieldKey(field.key);
  return field;
}

function requireCapableField(
  fieldKey: string,
  queryFields: readonly ActiveField[],
  capability: FieldCapability,
  purpose: string,
): ActiveField {
  const field = requireStatisticsField(fieldKey, queryFields);
  if (!fieldTypeHasCapability(field.type, capability)) {
    return invalidQuery(`Field "${field.key}" of type ${field.type} cannot be used ${purpose}`);
  }
  return field;
}

// DESIGN 9.4.2 的聚合表达式表。能力校验不在这里，统一走 domain/field-types.ts。
const MEASURE_EXPRESSIONS: Readonly<Record<FieldMeasure, (column: string) => string>> = {
  count: () => 'count()',
  unique: (column) => `uniqExact(${column})`,
  sum: (column) => `sum(${column})`,
  avg: (column) => `avg(${column})`,
  min: (column) => `min(${column})`,
  max: (column) => `max(${column})`,
  p50: (column) => `quantile(0.5)(${column})`,
  p90: (column) => `quantile(0.9)(${column})`,
  p99: (column) => `quantile(0.99)(${column})`,
};

// DESIGN 9.2：按天 / 按小时带时区，按分钟不带 —— 分钟桶在任何时区下的边界都一致。
const BUCKET_EXPRESSIONS: Readonly<Record<TrendGranularity, (column: string) => string>> = {
  day: (column) => `toStartOfDay(${column}, {tz:String})`,
  hour: (column) => `toStartOfHour(${column}, {tz:String})`,
  minute: (column) => `toStartOfMinute(${column})`,
};

const FILL_STEPS: Readonly<Record<TrendGranularity, string>> = {
  day: 'INTERVAL 1 DAY',
  hour: 'INTERVAL 1 HOUR',
  minute: 'INTERVAL 1 MINUTE',
};

export function statisticsMeasureExpression(
  measure: StatisticsMeasure,
  queryFields: readonly ActiveField[],
): string {
  if (measure.field === undefined) {
    return MEASURE_EXPRESSIONS[measure.fn]('');
  }
  const field = requireStatisticsField(measure.field, queryFields);
  if (!fieldTypeSupportsMeasure(field.type, measure.fn)) {
    return invalidQuery(
      `Field "${field.key}" of type ${field.type} does not support measure "${measure.fn}"`,
    );
  }
  return MEASURE_EXPRESSIONS[measure.fn](`\`${field.key}\``);
}

/** `_occurred_at` 是唯一被放行的系统列轴，其余轴必须具备 `timeAxis` 能力（DESIGN 9.4.1）。 */
export function resolveTimeAxis(
  axis: string,
  queryFields: readonly ActiveField[],
): { column: string; occurredAt: boolean } {
  if (axis === OCCURRED_AT_AXIS) {
    return { column: `\`${OCCURRED_AT_AXIS}\``, occurredAt: true };
  }
  const field = requireCapableField(axis, queryFields, 'timeAxis', 'as a statistics time axis');
  return { column: `\`${field.key}\``, occurredAt: false };
}

export function statisticsMeasureFieldType(
  measure: StatisticsMeasure,
  queryFields: readonly ActiveField[],
): ActiveField['type'] | undefined {
  return measure.field === undefined
    ? undefined
    : queryFields.find((candidate) => candidate.key === measure.field)?.type;
}

export function buildDetailStatement(
  definition: TableDefinition,
  input: DetailQueryInput,
  filter: FilterSql,
  selectedFields: readonly ActiveField[] = definition.fields,
): DetailStatement {
  const fingerprint = queryFingerprint({
    projectId: definition.projectId,
    range: input.range,
    ...(input.filter === undefined ? {} : { filter: input.filter }),
    includeFields: input.includeFields,
    order: input.order,
    schemaVersion: definition.schemaVersion,
  });
  const where = filteredWhere(input.range, filter);
  const params: Record<string, unknown> = { ...where.params, row_limit: input.limit + 1 };
  const clauses = [where.sql];
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor, fingerprint);
    const comparison = input.order === 'desc' ? '<' : '>';
    clauses.push(
      `(\`_occurred_at\`, \`_record_id\`) ${comparison} ({c_at:DateTime64(3, 'UTC')}, {c_id:UUID})`,
    );
    params.c_at = formatOccurredAt(cursor.at);
    params.c_id = cursor.id;
  }
  const direction = input.order === 'asc' ? 'ASC' : 'DESC';
  return {
    query: `SELECT ${selectedColumns(selectedFields)}
FROM ${physicalTable(definition)}
WHERE ${clauses.join('\n  AND ')}
ORDER BY \`_occurred_at\` ${direction}, \`_record_id\` ${direction}
LIMIT {row_limit:UInt32}`,
    params,
    fingerprint,
  };
}

/**
 * DESIGN 9.4.3 的三条语句。三者都带 `rows` 列（识别 `WITH FILL` 填出来的空桶 + 显示样本量）。
 *
 * 与 9.4.3 的片段相比只多一处：**时间维度也带 `WITH TOTALS`**。9.4.4 的响应形状里
 * `totals` 是必有项、10.6 又要求结果区把它显示出来，而 `avg` / 分位数的总计无法由各桶推出；
 * `WITH TOTALS` 让它和分组维度一样在同一次扫描里拿回来，避免 9.4.3 第一条明确反对的第二条查询。
 */
export function buildStatisticsStatement(
  definition: TableDefinition,
  input: StatisticsInput,
  filter: FilterSql,
  queryFields: readonly ActiveField[] = definition.fields,
): QueryStatement {
  const table = physicalTable(definition);
  const aggregate = statisticsMeasureExpression(input.measure, queryFields);
  const where = filteredWhere(input.range, filter);
  const params: Record<string, unknown> = { ...where.params, tz: input.tz };
  const clauses = [where.sql];

  if (input.dimension === undefined) {
    return {
      query: `SELECT ${aggregate} AS value, count() AS rows
FROM ${table}
WHERE ${clauses.join('\n  AND ')}`,
      params,
    };
  }

  if (input.dimension.kind === 'field') {
    const field = requireCapableField(
      input.dimension.field,
      queryFields,
      'groupable',
      'as a statistics grouping dimension',
    );
    // LIMIT n + 1 是 9.4.4 的截断探测；即便已经过 1..maxGroupLimit 校验也仍然参数化绑定。
    params.group_limit = input.dimension.limit + 1;
    return {
      query: `SELECT \`${field.key}\` AS key,
       ${aggregate} AS value,
       count() AS rows
FROM ${table}
WHERE ${clauses.join('\n  AND ')}
GROUP BY key
    WITH TOTALS
ORDER BY value DESC, key ASC
LIMIT {group_limit:UInt32}`,
      params,
    };
  }

  const { granularity } = input.dimension;
  const axis = resolveTimeAxis(input.dimension.axis, queryFields);
  if (!axis.occurredAt) {
    // DESIGN 9.4.3 第四条：业务时间轴要挡掉未提交该字段的行，否则它们会挤进一个假桶。
    clauses.push(`${axis.column} IS NOT NULL`);
  }
  // DESIGN 9.4.3 第二条：空桶补零只在 axis = _occurred_at 时做 —— 业务时间可以落在
  // range 之外的任何地方，起止无从推断。
  const fill = axis.occurredAt
    ? `
WITH FILL FROM ${BUCKET_EXPRESSIONS[granularity]("{start:DateTime64(3, 'UTC')}")}
             TO ${BUCKET_EXPRESSIONS[granularity]("{end:DateTime64(3, 'UTC')}")}
           STEP ${FILL_STEPS[granularity]}`
    : '';
  return {
    query: `SELECT ${BUCKET_EXPRESSIONS[granularity](axis.column)} AS bucket,
       ${aggregate} AS value,
       count() AS rows
FROM ${table}
WHERE ${clauses.join('\n  AND ')}
GROUP BY bucket
    WITH TOTALS
ORDER BY bucket${fill}`,
    params,
  };
}

/**
 * DESIGN 9.4.3 第四条 / 9.4.4：业务时间轴被 `IS NOT NULL` 排除掉的行数以 `nullAxisRows` 返回。
 * 主查询的 `WITH TOTALS` 只覆盖被保留的行，这一格拿不到，因此单独取一次 —— 这与
 * 9.4.3 第一条反对的「用第二条查询算总计」不是一回事，那条说的是分组占比的分母。
 */
export function buildNullAxisRowsStatement(
  definition: TableDefinition,
  input: StatisticsInput,
  filter: FilterSql,
  queryFields: readonly ActiveField[] = definition.fields,
): QueryStatement | null {
  if (input.dimension?.kind !== 'time') {
    return null;
  }
  const axis = resolveTimeAxis(input.dimension.axis, queryFields);
  if (axis.occurredAt) {
    return null;
  }
  const where = filteredWhere(input.range, filter);
  return {
    query: `SELECT count() AS count
FROM ${physicalTable(definition)}
WHERE ${where.sql}
  AND ${axis.column} IS NULL`,
    params: where.params,
  };
}

export function buildExportCountStatement(
  definition: TableDefinition,
  input: ExportInput,
  filter: FilterSql,
): QueryStatement {
  const where = filteredWhere(input.range, filter);
  return {
    query: `SELECT count() AS count
FROM ${physicalTable(definition)}
WHERE ${where.sql}`,
    params: where.params,
  };
}

export function buildExportStatement(
  definition: TableDefinition,
  input: ExportInput,
  filter: FilterSql,
  maxRows: number,
  selectedFields: readonly ActiveField[] = definition.fields,
): QueryStatement {
  const where = filteredWhere(input.range, filter);
  const direction = input.order === 'asc' ? 'ASC' : 'DESC';
  return {
    query: `SELECT ${selectedColumns(selectedFields)}
FROM ${physicalTable(definition)}
WHERE ${where.sql}
ORDER BY \`_occurred_at\` ${direction}, \`_record_id\` ${direction}
LIMIT {export_limit:UInt32}`,
    params: { ...where.params, export_limit: maxRows },
  };
}

export function buildRowCountStatement(definition: TableDefinition): QueryStatement {
  return {
    query: `SELECT count() AS count FROM ${physicalTable(definition)}`,
    params: {},
  };
}

export function parseClickHouseCount(value: unknown, context: string): number {
  const count = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Invalid ${context} returned by ClickHouse: ${String(value)}`);
  }
  return count;
}

export function clickHouseDateTimeToIso(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid DateTime64 value returned by ClickHouse: ${String(value)}`);
  }
  const hasZone = /(?:Z|[+-]\d\d(?::?\d\d)?)$/i.test(value);
  const normalized = `${value.replace(' ', 'T')}${hasZone ? '' : 'Z'}`;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid DateTime64 value returned by ClickHouse: ${value}`);
  }
  return new Date(timestamp).toISOString();
}
