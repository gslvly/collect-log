import type { ClickHouseClient, ClickHouseSettings, ResponseJSON } from '@clickhouse/client';
import type { FastifyRequest } from 'fastify';

import { AppError, type ErrorCode } from '../../errors.js';
import { classifyClickHouseError } from '../../infra/clickhouse.js';
import { ConcurrencyGate } from '../../infra/concurrency.js';
import { type AuthenticatedUser } from '../auth/jwt.js';
import type { TableRepository } from '../tables/repository.js';
import type { TableDefinition } from '../tables/types.js';
import type { ExportLimits, QueryLimits, QueryStatement } from './types.js';

export type QueryOperation = 'query' | 'statistics' | 'export' | 'row_count';

export interface OperationLogContext {
  projectId?: string;
  schemaVersion?: number;
}

export interface QueryRoutesContext {
  repository: TableRepository;
  queryLimits: QueryLimits;
  exportLimits: ExportLimits;
  queryGate: ConcurrencyGate;
  exportGate: ConcurrencyGate;
  client: ClickHouseClient;
  now: () => number;
  failureLogged: WeakSet<object>;
  querySettings: ClickHouseSettings;
}

export const QUERY_OUTPUT_SETTINGS = {
  output_format_json_quote_64bit_integers: 0,
  date_time_output_format: 'iso',
} as const satisfies ClickHouseSettings;

function errorCodeForLog(error: unknown): ErrorCode {
  return error instanceof AppError ? error.code : 'INTERNAL_ERROR';
}

// request.user 由 requireRole 里的 jwtVerify 填充，鉴权失败时 onError 钩子拿到的请求上还没有它。
function operatorForLog(request: FastifyRequest): string | undefined {
  const user = request.user as AuthenticatedUser | undefined;
  return typeof user?.username === 'string' ? user.username : undefined;
}

function projectIdForLog(request: FastifyRequest): string | undefined {
  if (typeof request.params !== 'object' || request.params === null) {
    return undefined;
  }
  const { projectId } = request.params as { projectId?: unknown };
  return typeof projectId === 'string' ? projectId : undefined;
}

export function logSuccess(
  request: FastifyRequest,
  definition: TableDefinition,
  operation: QueryOperation,
  rowCount: number,
): void {
  request.log.info(
    {
      requestId: request.id,
      operator: operatorForLog(request),
      projectId: definition.projectId,
      operation,
      schemaVersion: definition.schemaVersion,
      rowCount,
    },
    'collection data query completed',
  );
}

export function logFailure(
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
      operator: operatorForLog(request),
      projectId: context.projectId ?? projectIdForLog(request),
      operation,
      schemaVersion: context.schemaVersion,
      errorCode: errorCodeForLog(error),
    },
    'collection data query failed',
  );
}

export function translateClickHouseError(
  request: FastifyRequest,
  error: unknown,
): AppError {
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

export async function queryRows<Row>(
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

/**
 * 统计走 `FORMAT JSON` 而不是 `JSONEachRow`：`WITH TOTALS`（DESIGN 9.4.3 第一条）
 * 的总计行只在单文档 JSON 家族里作为 `totals` 字段回传，逐行格式会把它整个丢掉。
 */
export async function queryJsonDocument<Row>(
  request: FastifyRequest,
  client: ClickHouseClient,
  statement: QueryStatement,
  settings: ClickHouseSettings,
): Promise<ResponseJSON<Row>> {
  try {
    const result = await client.query({
      query: statement.query,
      query_params: statement.params,
      format: 'JSON',
      clickhouse_settings: settings,
    });
    return await result.json<Row>();
  } catch (error) {
    throw translateClickHouseError(request, error);
  }
}

export async function requireQueryableTable(
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

export function acquireGate(gate: ConcurrencyGate, operation: QueryOperation): () => void {
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
