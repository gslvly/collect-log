import type { ClickHouseClient, ClickHouseSettings } from '@clickhouse/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { configuredLimits } from '../../config/limits.js';
import { AppError, type ErrorCode } from '../../errors.js';
import { classifyClickHouseError, readonlyClient, streamCsvQuery } from '../../infra/clickhouse.js';
import { ConcurrencyGate } from '../../infra/concurrency.js';
import { requireRole } from '../auth/jwt.js';
import type { TableRepository } from '../tables/repository.js';
import type { TableDefinition } from '../tables/types.js';
import { encodeCursor } from './cursor.js';
import { buildFilterSql } from './filter.js';
import {
  parseDetailQuery,
  parseExportQuery,
  parseProjectId,
  parseStatisticsQuery,
} from './parse.js';
import {
  buildDetailStatement,
  buildExportCountStatement,
  buildExportStatement,
  buildRowCountStatement,
  buildStatisticsStatement,
  clickHouseDateTimeToIso,
  parseClickHouseCount,
} from './sql.js';
import type {
  DetailRow,
  ExportLimits,
  QueryLimits,
  QueryStatement,
  StatisticsInput,
} from './types.js';

type QueryOperation = 'query' | 'statistics' | 'export' | 'row_count';

export interface QueryRouteOptions {
  queryLimits?: Partial<QueryLimits>;
  exportLimits?: Partial<ExportLimits>;
  queryGate?: ConcurrencyGate;
  exportGate?: ConcurrencyGate;
  client?: ClickHouseClient;
  now?: () => number;
}

interface OperationLogContext {
  projectId?: string;
  schemaVersion?: number;
}

interface StatisticsResult {
  response: Record<string, unknown>;
  rowCount: number;
}

function errorCodeForLog(error: unknown): ErrorCode {
  return error instanceof AppError ? error.code : 'INTERNAL_ERROR';
}

function projectIdForLog(request: FastifyRequest): string | undefined {
  if (typeof request.params !== 'object' || request.params === null) {
    return undefined;
  }
  const { projectId } = request.params as { projectId?: unknown };
  return typeof projectId === 'string' ? projectId : undefined;
}

function logSuccess(
  request: FastifyRequest,
  definition: TableDefinition,
  operation: QueryOperation,
  rowCount: number,
): void {
  request.log.info(
    {
      requestId: request.id,
      projectId: definition.projectId,
      operation,
      schemaVersion: definition.schemaVersion,
      rowCount,
    },
    'collection data query completed',
  );
}

function logFailure(
  request: FastifyRequest,
  operation: QueryOperation,
  context: OperationLogContext,
  error: unknown,
  failureLogged?: WeakSet<object>,
): void {
  failureLogged?.add(request);
  request.log.warn(
    {
      requestId: request.id,
      projectId: context.projectId ?? projectIdForLog(request),
      operation,
      schemaVersion: context.schemaVersion,
      errorCode: errorCodeForLog(error),
    },
    'collection data query failed',
  );
}

function translateClickHouseError(request: FastifyRequest, error: unknown): AppError {
  const kind = classifyClickHouseError(error);
  if (kind === 'unavailable') {
    return new AppError('CLICKHOUSE_UNAVAILABLE', 'ClickHouse is temporarily unavailable');
  }
  if (kind === 'limit_exceeded') {
    return new AppError(
      'INVALID_QUERY',
      'Query exceeded ClickHouse limits; reduce the time range or number of conditions',
    );
  }
  request.log.error(
    {
      err: error,
      requestId: request.id,
      route: request.routeOptions.url ?? request.url,
    },
    'ClickHouse query failed',
  );
  return new AppError('INTERNAL_ERROR', 'ClickHouse query failed');
}

async function queryRows<Row>(
  request: FastifyRequest,
  client: ClickHouseClient,
  statement: QueryStatement,
  settings: ClickHouseSettings,
): Promise<Row[]> {
  try {
    const result = await client.query({
      query: statement.query,
      query_params: statement.params,
      format: 'JSONEachRow',
      clickhouse_settings: settings,
    });
    return result.json<Row>();
  } catch (error) {
    throw translateClickHouseError(request, error);
  }
}

async function requireQueryableTable(
  repository: TableRepository,
  projectId: string,
): Promise<TableDefinition> {
  const definition = await repository.getDefinition(projectId);
  if (definition === null) {
    throw new AppError('TABLE_NOT_FOUND', `Table "${projectId}" was not found`);
  }
  if (definition.status === 'creating' || definition.status === 'failed') {
    throw new AppError('TABLE_NOT_READY', `Table "${projectId}" is not ready`);
  }
  return definition;
}

function acquireGate(gate: ConcurrencyGate, operation: QueryOperation): () => void {
  if (!gate.tryAcquire()) {
    throw new AppError(
      'RATE_LIMITED',
      `${operation} concurrency limit reached, please try again later`,
    );
  }
  let released = false;
  return () => {
    if (!released) {
      released = true;
      gate.release();
    }
  };
}

function normalizeDetailRow(row: Record<string, unknown>): DetailRow {
  const recordId = row._record_id;
  const schemaVersion = Number(row._schema_version);
  if (typeof recordId !== 'string' || !Number.isSafeInteger(schemaVersion)) {
    throw new Error('ClickHouse returned an invalid detail row');
  }
  return {
    ...row,
    _record_id: recordId,
    _occurred_at: clickHouseDateTimeToIso(row._occurred_at),
    _received_at: clickHouseDateTimeToIso(row._received_at),
    _schema_version: schemaVersion,
  };
}

function parseSignedInteger(value: unknown, context: string): number {
  const integer = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(integer)) {
    throw new Error(`Invalid ${context} returned by ClickHouse: ${String(value)}`);
  }
  return integer;
}

function statisticsResponse(
  input: StatisticsInput,
  rows: Record<string, unknown>[],
): StatisticsResult {
  if (input.metric === 'total' || input.metric === 'unique') {
    const count = parseClickHouseCount(rows[0]?.count, `${input.metric} count`);
    return {
      response: {
        metric: input.metric,
        ...(input.field === undefined ? {} : { field: input.field }),
        count,
      },
      rowCount: count,
    };
  }

  if (input.metric === 'trend') {
    const buckets = rows.map((row) => ({
      bucket: new Date(
        parseSignedInteger(row.bucket_seconds, 'trend bucket') * 1_000,
      ).toISOString(),
      count: parseClickHouseCount(row.count, 'trend count'),
    }));
    return {
      response: { metric: input.metric, granularity: input.granularity, buckets },
      rowCount: buckets.reduce((total, bucket) => total + bucket.count, 0),
    };
  }

  if (input.metric === 'group') {
    const groups = rows.map((row) => {
      if (typeof row.value !== 'string') {
        throw new Error(`Invalid group value returned by ClickHouse: ${String(row.value)}`);
      }
      return { value: row.value, total: parseClickHouseCount(row.total, 'group total') };
    });
    return {
      response: { metric: input.metric, field: input.field, groups },
      rowCount: groups.reduce((total, group) => total + group.total, 0),
    };
  }

  const trueCount = parseClickHouseCount(rows[0]?.true_count, 'true count');
  const falseCount = parseClickHouseCount(rows[0]?.false_count, 'false count');
  const nullCount = parseClickHouseCount(rows[0]?.null_count, 'null count');
  const total = trueCount + falseCount + nullCount;
  return {
    response: {
      metric: input.metric,
      field: input.field,
      trueCount,
      falseCount,
      nullCount,
      total,
    },
    rowCount: total,
  };
}

function timestampForFilename(now: number): string {
  return new Date(now).toISOString().replaceAll(/\D/g, '').slice(0, 14);
}

function flushReplyHeadersToRaw(reply: FastifyReply): void {
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) {
      reply.raw.setHeader(name, value);
    }
  }
}

async function writeWithBackpressure(reply: FastifyReply, text: string): Promise<void> {
  if (reply.raw.destroyed) {
    throw new Error('Export response closed before writing completed');
  }
  if (reply.raw.write(text)) {
    return;
  }
  if (reply.raw.destroyed) {
    throw new Error('Export response closed before draining');
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      reply.raw.off('drain', onDrain);
      reply.raw.off('close', onClose);
      reply.raw.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Export response closed before draining'));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    reply.raw.once('drain', onDrain);
    reply.raw.once('close', onClose);
    reply.raw.once('error', onError);
  });
}

export function registerQueryRoutes(
  app: FastifyInstance,
  repository: TableRepository,
  options: QueryRouteOptions = {},
): void {
  const queryLimits: QueryLimits = { ...configuredLimits.query, ...options.queryLimits };
  const exportLimits: ExportLimits = { ...configuredLimits.export, ...options.exportLimits };
  const queryGate = options.queryGate ?? new ConcurrencyGate(queryLimits.maxConcurrent);
  const exportGate = options.exportGate ?? new ConcurrencyGate(exportLimits.maxConcurrent);
  const client = options.client ?? readonlyClient;
  const now = options.now ?? Date.now;
  const failureLogged = new WeakSet<object>();
  const querySettings = {
    max_execution_time: queryLimits.maxExecutionTimeSec,
    max_memory_usage: String(queryLimits.maxMemoryUsageBytes),
    max_result_rows: String(queryLimits.maxRows),
  };

  const operationByRoute: Readonly<Record<string, QueryOperation>> = {
    '/api/admin/tables/:projectId/query': 'query',
    '/api/admin/tables/:projectId/statistics': 'statistics',
    '/api/admin/tables/:projectId/export': 'export',
    '/api/admin/tables/:projectId/row-count': 'row_count',
  };

  // Authentication, content parsing, and other pre-handler failures happen before route try/catch blocks.
  app.addHook('onError', async (request, _reply, error) => {
    const operation = operationByRoute[request.routeOptions.url ?? ''];
    if (operation !== undefined && !failureLogged.has(request)) {
      logFailure(request, operation, {}, error, failureLogged);
    }
  });

  app.post(
    '/api/admin/tables/:projectId/query',
    { preHandler: requireRole('user', 'admin', 'super_admin') },
    async (request) => {
      const context: OperationLogContext = {};
      try {
        const projectId = parseProjectId(request.params);
        context.projectId = projectId;
        const definition = await requireQueryableTable(repository, projectId);
        context.schemaVersion = definition.schemaVersion;
        const release = acquireGate(queryGate, 'query');
        try {
          const input = parseDetailQuery(request.body, queryLimits);
          const filter = buildFilterSql(input.filter, definition.fields, queryLimits);
          const statement = buildDetailStatement(definition, input, filter);
          const rawRows = await queryRows<Record<string, unknown>>(request, client, statement, {
            ...querySettings,
            max_result_rows: String(queryLimits.maxRows + 1),
          });
          const hasMore = rawRows.length > input.limit;
          const rows = rawRows.slice(0, input.limit).map(normalizeDetailRow);
          const last = rows.at(-1);
          const nextCursor =
            hasMore && last !== undefined
              ? encodeCursor({
                  at: Date.parse(last._occurred_at),
                  id: last._record_id,
                  fp: statement.fingerprint,
                })
              : null;
          logSuccess(request, definition, 'query', rows.length);
          return { rows, nextCursor, hasMore };
        } finally {
          release();
        }
      } catch (error) {
        logFailure(request, 'query', context, error, failureLogged);
        throw error;
      }
    },
  );

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
          const filter = buildFilterSql(input.filter, definition.fields, queryLimits);
          const statement = buildStatisticsStatement(definition, input, filter);
          const rows = await queryRows<Record<string, unknown>>(
            request,
            client,
            statement,
            querySettings,
          );
          const result = statisticsResponse(input, rows);
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

  app.post(
    '/api/admin/tables/:projectId/export',
    { preHandler: requireRole('user', 'admin', 'super_admin') },
    async (request, reply) => {
      const context: OperationLogContext = {};
      let streamStarted = false;
      let streamFailureLogged = false;
      try {
        const projectId = parseProjectId(request.params);
        context.projectId = projectId;
        const definition = await requireQueryableTable(repository, projectId);
        context.schemaVersion = definition.schemaVersion;
        const release = acquireGate(exportGate, 'export');
        const abortController = new AbortController();
        const releaseOnClose = () => {
          abortController.abort();
          release();
        };
        reply.raw.once('close', releaseOnClose);
        try {
          const input = parseExportQuery(request.body, queryLimits);
          const filter = buildFilterSql(input.filter, definition.fields, queryLimits);
          const countStatement = buildExportCountStatement(definition, input, filter);
          const countRows = await queryRows<{ count: string | number }>(
            request,
            client,
            countStatement,
            {
              max_execution_time: exportLimits.maxExecutionTimeSec,
              max_memory_usage: String(queryLimits.maxMemoryUsageBytes),
              max_result_rows: '1',
            },
          );
          const total = parseClickHouseCount(countRows[0]?.count, 'export count');
          const truncated = total > exportLimits.maxRows;
          const exportStatement = buildExportStatement(
            definition,
            input,
            filter,
            exportLimits.maxRows,
          );
          let stream: AsyncIterable<readonly { text: string }[]>;
          try {
            stream = await streamCsvQuery({
              client,
              query: exportStatement.query,
              params: exportStatement.params,
              clickhouseSettings: {
                max_execution_time: exportLimits.maxExecutionTimeSec,
                max_memory_usage: String(queryLimits.maxMemoryUsageBytes),
                max_result_rows: String(exportLimits.maxRows),
                result_overflow_mode: 'break',
              },
              abortSignal: abortController.signal,
            });
          } catch (error) {
            throw translateClickHouseError(request, error);
          }

          void reply.header('content-type', 'text/csv; charset=utf-8');
          void reply.header(
            'content-disposition',
            `attachment; filename="collect_${projectId}_${timestampForFilename(now())}.csv"`,
          );
          if (truncated) {
            void reply.header('x-export-truncated', '1');
          }
          flushReplyHeadersToRaw(reply);
          reply.hijack();
          streamStarted = true;

          try {
            for await (const rows of stream) {
              for (const row of rows) {
                await writeWithBackpressure(reply, `${row.text}\n`);
              }
            }
            if (truncated) {
              await writeWithBackpressure(
                reply,
                `# truncated: exported ${exportLimits.maxRows} of ${total} rows\n`,
              );
            }
          } catch (error) {
            const translated = translateClickHouseError(request, error);
            logFailure(request, 'export', context, translated, failureLogged);
            streamFailureLogged = true;
            request.log.error(
              {
                err: error,
                requestId: request.id,
                projectId,
                schemaVersion: definition.schemaVersion,
              },
              'CSV export stream failed after response headers were sent',
            );
            reply.raw.destroy();
            return reply;
          }

          reply.raw.end();
          logSuccess(request, definition, 'export', Math.min(total, exportLimits.maxRows));
          return reply;
        } finally {
          reply.raw.off('close', releaseOnClose);
          release();
        }
      } catch (error) {
        if (!streamFailureLogged) {
          logFailure(request, 'export', context, error, failureLogged);
        }
        if (streamStarted) {
          request.log.error(
            { err: error, requestId: request.id, projectId: context.projectId },
            'CSV export failed after response headers were sent',
          );
          reply.raw.destroy();
          return reply;
        }
        throw error;
      }
    },
  );

  app.get(
    '/api/admin/tables/:projectId/row-count',
    { preHandler: requireRole('admin', 'super_admin') },
    async (request) => {
      const context: OperationLogContext = {};
      try {
        const projectId = parseProjectId(request.params);
        context.projectId = projectId;
        const definition = await requireQueryableTable(repository, projectId);
        context.schemaVersion = definition.schemaVersion;
        const release = acquireGate(queryGate, 'row_count');
        try {
          const rows = await queryRows<{ count: string | number }>(
            request,
            client,
            buildRowCountStatement(definition),
            querySettings,
          );
          const count = parseClickHouseCount(rows[0]?.count, 'row count');
          logSuccess(request, definition, 'row_count', count);
          return { count };
        } finally {
          release();
        }
      } catch (error) {
        logFailure(request, 'row_count', context, error, failureLogged);
        throw error;
      }
    },
  );
}
