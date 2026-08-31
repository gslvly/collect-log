import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { streamCsvQuery } from '../../infra/clickhouse.js';
import { requestDurationMs } from '../../request-timing.js';
import { requireRole } from '../auth/jwt.js';
import { queryableFields, selectedDetailFields } from './fields.js';
import { buildFilterSql } from './filter.js';
import { parseExportQuery, parseProjectId } from './parse.js';
import {
  QUERY_OUTPUT_SETTINGS,
  acquireGate,
  logFailure,
  logSuccess,
  queryRows,
  requireQueryableTable,
  translateClickHouseError,
  type OperationLogContext,
  type QueryRoutesContext,
} from './routes.shared.js';
import {
  buildExportCountStatement,
  buildExportStatement,
  parseClickHouseCount,
} from './sql.js';

function timestampForFilename(now: number): string {
  return new Date(now).toISOString().replaceAll(/\D/g, '').slice(0, 14);
}

// hijack() 之后 Fastify 不再接管响应，app.ts 的 onResponse 钩子不触发，
// DESIGN 12.4 的四要素只能在这里手动补齐。statusCode 取实际写出的状态行：
// 流中途失败时响应头早已以 200 发出，此时用 bodyComplete 区分完整下载与中断。
function logHijackedResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  bodyComplete: boolean,
): void {
  request.log.info(
    {
      requestId: request.id,
      route: request.routeOptions.url ?? request.url,
      statusCode: reply.raw.statusCode,
      durationMs: requestDurationMs(request),
      bodyComplete,
    },
    'request completed',
  );
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

export function registerExportRoute(app: FastifyInstance, routes: QueryRoutesContext): void {
  const {
    repository,
    queryLimits,
    exportLimits,
    exportGate,
    client,
    now,
    failureLogged,
  } = routes;

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
          const fieldRecords = await repository.listFields(projectId);
          const filter = buildFilterSql(input.filter, queryableFields(fieldRecords), queryLimits);
          // 列集合先算出来，非法的 includeFields 不该先跑掉一次全量 COUNT 再被拒。
          const selectedFields = selectedDetailFields(fieldRecords, input.includeFields);
          const countStatement = buildExportCountStatement(definition, input, filter);
          const countRows = await queryRows<{ count: string | number }>(
            request,
            client,
            countStatement,
            {
              max_execution_time: exportLimits.maxExecutionTimeSec,
              max_memory_usage: String(queryLimits.maxMemoryUsageBytes),
              max_result_rows: '1',
              ...QUERY_OUTPUT_SETTINGS,
            },
          );
          const total = parseClickHouseCount(countRows[0]?.count, 'export count');
          const truncated = total > exportLimits.maxRows;
          const exportStatement = buildExportStatement(
            definition,
            input,
            filter,
            exportLimits.maxRows,
            selectedFields,
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
                ...QUERY_OUTPUT_SETTINGS,
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
            logHijackedResponse(request, reply, false);
            return reply;
          }

          reply.raw.end();
          logSuccess(request, definition, 'export', Math.min(total, exportLimits.maxRows));
          logHijackedResponse(request, reply, true);
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
          logHijackedResponse(request, reply, false);
          return reply;
        }
        // 未 hijack 时响应仍由 Fastify 发送，onResponse 会输出四要素，这里不能重复补。
        throw error;
      }
    },
  );
}
