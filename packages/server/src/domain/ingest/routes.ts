import type { FastifyInstance, FastifyRequest } from 'fastify';

import { env } from '../../config/env.js';
import { configuredLimits } from '../../config/limits.js';
import { AppError, type ErrorCode } from '../../errors.js';
import { classifyClickHouseError } from '../../infra/clickhouse.js';
import type { TableRepository } from '../tables/repository.js';
import { parseEnvelope } from './envelope.js';
import { NonceCache } from './nonce.js';
import { IngestRateLimiter } from './rate-limit.js';
import { verifyEnvelopeSignature } from './signature.js';
import { parsePayload, validateFieldValues } from './validate.js';
import { buildIngestRow, insertIngestRow, type IngestRow } from './writer.js';

const PROJECT_ID_PATTERN = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const INGEST_ROUTE = '/api/ingest/v1/projects/:projectId/rows';

export type IngestWriter = (physicalName: string, row: IngestRow) => Promise<void>;

export interface IngestRouteOptions {
  allowedOrigins?: readonly string[];
  nonceCache?: NonceCache;
  rateLimiter?: IngestRateLimiter;
  now?: () => number;
  writer?: IngestWriter;
}

function originAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  return origin === undefined || allowedOrigins.includes('*') || allowedOrigins.includes(origin);
}

function errorCodeForLog(error: unknown): ErrorCode {
  if (error instanceof AppError) {
    return error.code;
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return 'PAYLOAD_TOO_LARGE';
    }
    if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return 'UNSUPPORTED_MEDIA_TYPE';
    }
  }
  return 'INTERNAL_ERROR';
}

function projectIdForLog(request: FastifyRequest): string | undefined {
  if (typeof request.params !== 'object' || request.params === null) {
    return undefined;
  }
  const { projectId } = request.params as { projectId?: unknown };
  return typeof projectId === 'string' ? projectId : undefined;
}

export function registerIngestRoutes(
  app: FastifyInstance,
  repository: TableRepository,
  options: IngestRouteOptions = {},
): void {
  const allowedOrigins = options.allowedOrigins ?? env.INGEST_ALLOWED_ORIGINS;
  const now = options.now ?? Date.now;
  const nonceCache =
    options.nonceCache ??
    new NonceCache(
      configuredLimits.ingest.nonceCacheSize,
      configuredLimits.ingest.signatureWindowMs,
      now,
    );
  const rateLimiter =
    options.rateLimiter ??
    new IngestRateLimiter(
      configuredLimits.ingest.rateLimitPerIp,
      configuredLimits.ingest.rateLimitPerTable,
      now,
    );
  const writer = options.writer ?? insertIngestRow;
  const failureLogged = new WeakSet<object>();

  const logFailure = (
    request: FastifyRequest,
    error: unknown,
    fallbackSchemaVersion?: number,
  ): void => {
    failureLogged.add(request);
    const appError = error instanceof AppError ? error : undefined;
    request.log.warn(
      {
        requestId: request.id,
        projectId: projectIdForLog(request),
        errorCode: errorCodeForLog(error),
        field: appError?.field,
        schemaVersion: appError?.schemaVersion ?? fallbackSchemaVersion,
      },
      'ingest request failed',
    );
  };

  app.addHook('onClose', async () => {
    nonceCache.close();
    rateLimiter.close();
  });

  // Content-type parsing and body limits fail before the handler's try/catch.
  app.addHook('onError', async (request, _reply, error) => {
    if (request.routeOptions.url === INGEST_ROUTE && !failureLogged.has(request)) {
      logFailure(request, error);
    }
  });

  app.post<{ Params: { projectId: string }; Body: string }>(INGEST_ROUTE, async (request) => {
    const { projectId } = request.params;
    let schemaVersion: number | undefined;

    try {
      if (!originAllowed(request.headers.origin, allowedOrigins)) {
        throw new AppError('FORBIDDEN', 'Origin is not allowed for ingest');
      }

      if (!rateLimiter.consumeIp(request.ip) || !rateLimiter.consumeProject(projectId)) {
        throw new AppError('RATE_LIMITED', 'Ingest rate limit exceeded');
      }

      if (!PROJECT_ID_PATTERN.test(projectId)) {
        throw new AppError('INVALID_PROJECT_ID', `Project ID "${projectId}" is invalid`);
      }

      const envelope = parseEnvelope(request.body);
      if (envelope.p !== projectId) {
        throw new AppError('INVALID_ENVELOPE', 'Envelope project does not match the URL');
      }

      const definition = await repository.getDefinition(projectId);
      if (definition === null) {
        throw new AppError('TABLE_NOT_FOUND', `Table "${projectId}" was not found`);
      }
      schemaVersion = definition.schemaVersion;
      const requestNow = now();

      if (Math.abs(requestNow - envelope.t) > configuredLimits.ingest.signatureWindowMs) {
        throw new AppError('SIGNATURE_EXPIRED', 'Envelope signature timestamp has expired');
      }
      if (!nonceCache.consume(projectId, envelope.n)) {
        throw new AppError('REPLAYED_NONCE', 'Envelope nonce has already been used');
      }
      if (!verifyEnvelopeSignature(envelope, definition, requestNow)) {
        throw new AppError('INVALID_SIGNATURE', 'Envelope signature is invalid');
      }

      if (definition.status === 'disabled' || definition.status === 'archived') {
        throw new AppError('TABLE_DISABLED', `Table "${projectId}" is disabled`);
      }
      if (definition.status === 'creating' || definition.status === 'failed') {
        throw new AppError('TABLE_NOT_READY', `Table "${projectId}" is not ready`);
      }

      if (Buffer.byteLength(envelope.d, 'utf8') > configuredLimits.ingest.maxPayloadBytes) {
        throw new AppError('PAYLOAD_TOO_LARGE', 'Payload d exceeds the allowed size');
      }
      const payload = parsePayload(envelope.d, requestNow, configuredLimits.ingest);
      const values = await validateFieldValues(
        payload.data,
        definition,
        (id) => repository.listFields(id),
        configuredLimits.ingest,
      );
      const row = buildIngestRow(definition, payload, values);

      try {
        await writer(definition.physicalName, row);
      } catch (error) {
        request.log.error(
          {
            err: error,
            requestId: request.id,
            projectId,
            schemaVersion,
          },
          'ingest insert failed',
        );
        if (classifyClickHouseError(error) === 'unavailable') {
          throw new AppError('CLICKHOUSE_UNAVAILABLE', 'ClickHouse is temporarily unavailable');
        }
        throw new AppError('INSERT_FAILED', 'ClickHouse insert failed');
      }

      return { success: true, recordId: payload.recordId, requestId: request.id };
    } catch (error) {
      logFailure(request, error, schemaVersion);
      throw error;
    }
  });
}
