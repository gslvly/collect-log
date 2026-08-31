import type { ResponseJSON } from '@clickhouse/client';
import type { FastifyInstance } from 'fastify';

import { requireRole } from '../auth/jwt.js';
import type { FieldMeasure } from '../field-types.js';
import type { ActiveField } from '../tables/types.js';
import { queryableFields } from './fields.js';
import { buildFilterSql } from './filter.js';
import { parseProjectId, parseStatisticsQuery } from './parse.js';
import {
  acquireGate,
  logFailure,
  logSuccess,
  queryJsonDocument,
  queryRows,
  requireQueryableTable,
  type OperationLogContext,
  type QueryRoutesContext,
} from './routes.shared.js';
import {
  buildNullAxisRowsStatement,
  buildStatisticsStatement,
  clickHouseDateTimeToIso,
  parseClickHouseCount,
  statisticsMeasureFieldType,
} from './sql.js';
import type { StatisticsInput } from './types.js';

interface StatisticsResult {
  response: Record<string, unknown>;
  rowCount: number;
}

interface StatisticsRawRow extends Record<string, unknown> {
  key?: unknown;
  bucket?: unknown;
  value?: unknown;
  rows?: unknown;
}

type StatisticsValue = number | string | null;
type StatisticsKey = string | number | boolean | null;

interface StatisticsRow {
  key?: StatisticsKey;
  value: StatisticsValue;
  rows: number;
  share?: number;
}

/**
 * DESIGN 9.4.3 第三条：`WITH FILL` 填出来的空桶拿到的是列默认值。
 * 对 `count` / `sum` 恰好正确（该桶确实是 0），`unique` 同理（0 个不同取值）；
 * 对 `avg` / `min` / `max` / 分位数是错的，必须改写成 `null`。
 */
const ZERO_VALUED_ON_EMPTY_BUCKET: ReadonlySet<FieldMeasure> = new Set<FieldMeasure>([
  'count',
  'sum',
  'unique',
]);

/** DESIGN 9.4.4：`others` 只在可加的 `count` / `sum` 时给，其余指标只给 `truncated`。 */
const ADDITIVE_MEASURES: ReadonlySet<FieldMeasure> = new Set<FieldMeasure>(['count', 'sum']);

function statisticsValue(value: unknown, isDateTime: boolean): StatisticsValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (isDateTime) {
    return clickHouseDateTimeToIso(value);
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  // ClickHouse 把 nan / inf 输出成 JSON null；这里只兜住类型异常的情况。
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric;
}

function statisticsKey(value: unknown): StatisticsKey {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  throw new Error(`Invalid group key returned by ClickHouse: ${String(value)}`);
}

function statisticsResponse(
  input: StatisticsInput,
  document: ResponseJSON<StatisticsRawRow>,
  queryFields: readonly ActiveField[],
  nullAxisRows: number | null,
): StatisticsResult {
  const { fn } = input.measure;
  const isDateTime =
    (fn === 'min' || fn === 'max') &&
    statisticsMeasureFieldType(input.measure, queryFields) === 'datetime';
  const kind = input.dimension?.kind ?? null;
  const limit = input.dimension?.kind === 'field' ? input.dimension.limit : null;
  const data = document.data;
  const truncated = limit !== null && data.length > limit;
  const visible = limit === null ? data : data.slice(0, limit);

  const totalsSource = kind === null ? data[0] : document.totals;
  const totals = {
    value: statisticsValue(totalsSource?.value, isDateTime),
    rows: parseClickHouseCount(totalsSource?.rows ?? 0, 'statistics totals row count'),
  };

  // share / others 只在数值型指标上出现（count / sum），此时 totals.value 必是数字。
  const numericTotal = typeof totals.value === 'number' ? totals.value : 0;

  const rows: StatisticsRow[] = visible.map((raw) => {
    const rowCount = parseClickHouseCount(raw.rows ?? 0, 'statistics bucket row count');
    const filled = kind === 'time' && rowCount === 0;
    const value = filled
      ? ZERO_VALUED_ON_EMPTY_BUCKET.has(fn)
        ? 0
        : null
      : statisticsValue(raw.value, isDateTime);
    return {
      // DESIGN 9.4.4：时间维度的 key 是桶起点的 ISO 8601 UTC 串，字段维度是该字段的取值，
      // 且 key 为 null 的那一组（未提交该字段）必须原样返回。
      ...(kind === 'time' ? { key: clickHouseDateTimeToIso(raw.bucket) } : {}),
      ...(kind === 'field' ? { key: statisticsKey(raw.key) } : {}),
      value,
      rows: rowCount,
      ...(fn === 'count'
        ? { share: numericTotal === 0 ? 0 : Number(value ?? 0) / numericTotal }
        : {}),
    };
  });

  const others =
    kind === 'field' && ADDITIVE_MEASURES.has(fn)
      ? { value: numericTotal - rows.reduce((sum, row) => sum + Number(row.value ?? 0), 0) }
      : undefined;

  return {
    response: {
      dimension: kind,
      measure: {
        fn,
        ...(input.measure.field === undefined ? {} : { field: input.measure.field }),
      },
      rows,
      totals,
      ...(others === undefined ? {} : { others }),
      truncated,
      ...(nullAxisRows === null ? {} : { nullAxisRows }),
    },
    rowCount: totals.rows,
  };
}

export function registerStatisticsRoute(
  app: FastifyInstance,
  routes: QueryRoutesContext,
): void {
  const { repository, queryLimits, queryGate, client, failureLogged, querySettings } = routes;

  app.post(
    '/api/admin/tables/:projectId/statistics',
    { preHandler: requireRole('user', 'admin', 'super_admin') },
    async (request) => {
      const context: OperationLogContext = {};
      try {
        const projectId = parseProjectId(request.params);
        context.projectId = projectId;
        const definition = await requireQueryableTable(repository, projectId);
        context.schemaVersion = definition.schemaVersion;
        const release = acquireGate(queryGate, 'statistics');
        try {
          const input = parseStatisticsQuery(request.body, queryLimits);
          const fields = queryableFields(await repository.listFields(projectId));
          const filter = buildFilterSql(input.filter, fields, queryLimits);
          const statement = buildStatisticsStatement(definition, input, filter, fields);
          const nullAxisStatement = buildNullAxisRowsStatement(definition, input, filter, fields);
          const document = await queryJsonDocument<StatisticsRawRow>(
            request,
            client,
            statement,
            querySettings,
          );
          let nullAxisRows: number | null = null;
          if (nullAxisStatement !== null) {
            const nullAxisRowsResult = await queryRows<{ count: string | number }>(
              request,
              client,
              nullAxisStatement,
              querySettings,
            );
            nullAxisRows = parseClickHouseCount(
              nullAxisRowsResult[0]?.count,
              'null axis row count',
            );
          }
          const result = statisticsResponse(input, document, fields, nullAxisRows);
          logSuccess(request, definition, 'statistics', result.rowCount);
          return result.response;
        } finally {
          release();
        }
      } catch (error) {
        logFailure(request, 'statistics', context, error, failureLogged);
        throw error;
      }
    },
  );
}
