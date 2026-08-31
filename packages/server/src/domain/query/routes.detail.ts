import type { FastifyInstance } from 'fastify';

import { requireRole } from '../auth/jwt.js';
import { encodeCursor } from './cursor.js';
import { queryableFields, selectedDetailFields } from './fields.js';
import { buildFilterSql } from './filter.js';
import { parseDetailQuery, parseProjectId } from './parse.js';
import {
  acquireGate,
  logFailure,
  logSuccess,
  queryRows,
  requireQueryableTable,
  type OperationLogContext,
  type QueryRoutesContext,
} from './routes.shared.js';
import {
  buildDetailStatement,
  buildRowCountStatement,
  clickHouseDateTimeToIso,
  parseClickHouseCount,
} from './sql.js';
import type { DetailRow } from './types.js';

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

export function registerDetailRoutes(app: FastifyInstance, routes: QueryRoutesContext): void {
  const {
    repository,
    queryLimits,
    queryGate,
    client,
    failureLogged,
    querySettings,
  } = routes;

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
          const fieldRecords = await repository.listFields(projectId);
          const filter = buildFilterSql(input.filter, queryableFields(fieldRecords), queryLimits);
          const statement = buildDetailStatement(
            definition,
            input,
            filter,
            selectedDetailFields(fieldRecords, input.includeFields),
          );
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
