import { AppError } from '../../errors.js';
import { assertIdentifier } from '../../infra/clickhouse.js';
import { formatOccurredAt } from '../ingest/writer.js';
import { assertValidFieldKey } from '../tables/schema.js';
import type { ActiveField, TableDefinition } from '../tables/types.js';
import { decodeCursor, queryFingerprint } from './cursor.js';
import type {
  DetailQueryInput,
  ExportInput,
  FilterSql,
  QueryStatement,
  StatisticsInput,
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
  const businessColumns = activeFields.map((field) => `\`${assertValidFieldKey(field.key)}\``);
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

function requireStatisticField(
  fieldKey: string | undefined,
  activeFields: readonly ActiveField[],
  expectedType: 'string' | 'boolean',
  metric: StatisticsInput['metric'],
): ActiveField {
  if (fieldKey === undefined || fieldKey.startsWith('_')) {
    return invalidQuery(`Unknown field "${String(fieldKey)}"`);
  }
  const field = activeFields.find((candidate) => candidate.key === fieldKey);
  if (field === undefined) {
    return invalidQuery(`Unknown field "${fieldKey}"`);
  }
  assertValidFieldKey(field.key);
  if (field.type !== expectedType) {
    return invalidQuery(`${metric} statistics require a ${expectedType} field`);
  }
  return field;
}

export function buildDetailStatement(
  definition: TableDefinition,
  input: DetailQueryInput,
  filter: FilterSql,
): DetailStatement {
  const fingerprint = queryFingerprint({
    projectId: definition.projectId,
    range: input.range,
    ...(input.filter === undefined ? {} : { filter: input.filter }),
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
    query: `SELECT ${selectedColumns(definition.fields)}
FROM ${physicalTable(definition)}
WHERE ${clauses.join('\n  AND ')}
ORDER BY \`_occurred_at\` ${direction}, \`_record_id\` ${direction}
LIMIT {row_limit:UInt32}`,
    params,
    fingerprint,
  };
}

export function buildStatisticsStatement(
  definition: TableDefinition,
  input: StatisticsInput,
  filter: FilterSql,
): QueryStatement {
  const where = filteredWhere(input.range, filter);
  const params: Record<string, unknown> = { ...where.params, tz: input.tz };
  const table = physicalTable(definition);

  if (input.metric === 'total') {
    return {
      query: `SELECT count() AS count
FROM ${table}
WHERE ${where.sql}`,
      params,
    };
  }

  if (input.metric === 'trend') {
    const expression =
      input.granularity === undefined
        ? undefined
        : {
            day: 'toStartOfDay(`_occurred_at`, {tz:String})',
            hour: 'toStartOfHour(`_occurred_at`, {tz:String})',
            minute: 'toStartOfMinute(`_occurred_at`)',
          }[input.granularity];
    if (expression === undefined) {
      return invalidQuery('Granularity is required for trend statistics');
    }
    return {
      query: `SELECT ${expression} AS bucket,
  toUnixTimestamp(bucket) AS bucket_seconds,
  count() AS count
FROM ${table}
WHERE ${where.sql}
GROUP BY bucket
ORDER BY bucket ASC`,
      params,
    };
  }

  if (input.metric === 'unique') {
    const field = requireStatisticField(input.field, definition.fields, 'string', input.metric);
    const column = `\`${field.key}\``;
    return {
      query: `SELECT uniqExact(${column}) AS count
FROM ${table}
WHERE ${where.sql}
  AND ${column} IS NOT NULL
  AND ${column} != ''`,
      params,
    };
  }

  if (input.metric === 'group') {
    const field = requireStatisticField(input.field, definition.fields, 'string', input.metric);
    const column = `\`${field.key}\``;
    // Top N is bound as UInt32 instead of interpolated, even though it was already validated as 1..500.
    params.group_limit = input.limit ?? 50;
    return {
      query: `SELECT ${column} AS value, count() AS total
FROM ${table}
WHERE ${where.sql}
  AND ${column} IS NOT NULL
GROUP BY value
ORDER BY total DESC, value ASC
LIMIT {group_limit:UInt32}`,
      params,
    };
  }

  const field = requireStatisticField(input.field, definition.fields, 'boolean', input.metric);
  const column = `\`${field.key}\``;
  return {
    query: `SELECT countIf(${column} = true) AS true_count,
  countIf(${column} = false) AS false_count,
  countIf(${column} IS NULL) AS null_count
FROM ${table}
WHERE ${where.sql}`,
    params,
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
): QueryStatement {
  const where = filteredWhere(input.range, filter);
  const direction = input.order === 'asc' ? 'ASC' : 'DESC';
  return {
    query: `SELECT ${selectedColumns(definition.fields)}
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
