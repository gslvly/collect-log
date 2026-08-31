import type { ClickHouseClient } from '@clickhouse/client';
import type { FastifyInstance } from 'fastify';

import { configuredLimits } from '../../config/limits.js';
import { readonlyClient } from '../../infra/clickhouse.js';
import { ConcurrencyGate } from '../../infra/concurrency.js';
import type { TableRepository } from '../tables/repository.js';
import { registerDetailRoutes } from './routes.detail.js';
import { registerExportRoute } from './routes.export.js';
import {
  QUERY_OUTPUT_SETTINGS,
  logFailure,
  type QueryOperation,
  type QueryRoutesContext,
} from './routes.shared.js';
import { registerStatisticsRoute } from './routes.statistics.js';
import type { ExportLimits, QueryLimits } from './types.js';

export { QUERY_OUTPUT_SETTINGS } from './routes.shared.js';

export interface QueryRouteOptions {
  queryLimits?: Partial<QueryLimits>;
  exportLimits?: Partial<ExportLimits>;
  queryGate?: ConcurrencyGate;
  exportGate?: ConcurrencyGate;
  client?: ClickHouseClient;
  now?: () => number;
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
  const failureLogged = new WeakSet<object>();
  const querySettings = {
    max_execution_time: queryLimits.maxExecutionTimeSec,
    max_memory_usage: String(queryLimits.maxMemoryUsageBytes),
    max_result_rows: String(queryLimits.maxRows),
    ...QUERY_OUTPUT_SETTINGS,
  };
  const context: QueryRoutesContext = {
    repository,
    queryLimits,
    exportLimits,
    queryGate,
    exportGate,
    client: options.client ?? readonlyClient,
    now: options.now ?? Date.now,
    failureLogged,
    querySettings,
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

  registerDetailRoutes(app, context);
  registerStatisticsRoute(app, context);
  registerExportRoute(app, context);
}
