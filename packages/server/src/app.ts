import cors, { type FastifyCorsOptionsDelegate } from '@fastify/cors';
import Fastify, { LogController } from 'fastify';
import { ulid } from 'ulid';

import { env } from './config/env.js';
import { configuredLimits } from './config/limits.js';
import { registerFieldTypeRoutes } from './domain/field-types.js';
import { CaptchaService } from './domain/auth/captcha.js';
import { registerJwt } from './domain/auth/jwt.js';
import { CaptchaRateLimiter, LoginRateLimiter } from './domain/auth/rate-limit.js';
import { registerAuthRoutes } from './domain/auth/routes.js';
import { registerIngestRoutes } from './domain/ingest/routes.js';
import { registerQueryRoutes, type QueryRouteOptions } from './domain/query/routes.js';
import { tableRepository, type TableRepository } from './domain/tables/repository.js';
import { registerTableRoutes } from './domain/tables/routes.js';
import { userRepository, type UserRepository } from './domain/users/repository.js';
import { registerUserRoutes } from './domain/users/routes.js';
import { AppError, ERROR_HTTP_STATUS, serializeError, type ErrorCode } from './errors.js';
import { pingClickHouse } from './infra/clickhouse.js';
import { pingSqlite } from './infra/sqlite.js';
import { reconcileState } from './reconcile-state.js';
import { markRequestStart, requestDurationMs } from './request-timing.js';

function isPayloadTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
  );
}

function isInvalidJson(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'FST_ERR_CTP_INVALID_JSON_BODY'
  );
}

// Fastify 内建的客户端错误（空 body、不支持的 content-type、请求校验失败……）
// 必须保持 4xx，不能被兜底分支降级成 500。
const CLIENT_ERROR_CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'INVALID_JSON',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'ROUTE_NOT_FOUND',
  405: 'ROUTE_NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

function clientErrorCode(error: unknown): ErrorCode | null {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return null;
  }

  const { statusCode } = error;
  if (typeof statusCode !== 'number' || statusCode < 400 || statusCode >= 500) {
    return null;
  }
  return CLIENT_ERROR_CODE_BY_STATUS[statusCode] ?? 'INVALID_JSON';
}

export interface BuildAppOptions {
  captchaService?: CaptchaService;
  captchaRateLimiter?: CaptchaRateLimiter;
  loginRateLimiter?: LoginRateLimiter;
  pingClickHouse?: () => Promise<void>;
  pingSqlite?: () => Promise<void>;
  queryRouteOptions?: QueryRouteOptions;
  tableRepository?: TableRepository;
  userRepository?: UserRepository;
  // 测试用：把结构化日志导向可断言的流，同时绕开 LOG_LEVEL=silent。
  logStream?: { write(line: string): void };
}

export async function buildApp(options: BuildAppOptions = {}) {
  const captchaService = options.captchaService ?? new CaptchaService();
  const captchaRateLimiter = options.captchaRateLimiter ?? new CaptchaRateLimiter();
  const loginRateLimiter = options.loginRateLimiter ?? new LoginRateLimiter();
  const checkClickHouse = options.pingClickHouse ?? pingClickHouse;
  const checkSqlite = options.pingSqlite ?? pingSqlite;
  const tables = options.tableRepository ?? tableRepository;
  const users = options.userRepository ?? userRepository;
  const app = Fastify({
    logger: {
      level: options.logStream === undefined ? env.LOG_LEVEL : 'info',
      ...(options.logStream === undefined ? {} : { stream: options.logStream }),
    },
    logController: new LogController({
      disableRequestLogging: true,
    }),
    genReqId: () => `req_${ulid()}`,
  });

  const corsDelegate: FastifyCorsOptionsDelegate = (request, callback) => {
    if (!request.url.startsWith('/api/')) {
      callback(null, { origin: false });
      return;
    }

    const isIngestRequest = request.url.startsWith('/api/ingest/');
    const allowedOrigins = isIngestRequest
      ? env.INGEST_ALLOWED_ORIGINS
      : env.CONSOLE_ALLOWED_ORIGINS;
    callback(null, {
      origin: isIngestRequest && allowedOrigins.includes('*') ? '*' : allowedOrigins,
      exposedHeaders: ['Content-Disposition', 'X-Export-Truncated', 'X-Request-Id'],
    });
  };

  await app.register(cors, () => corsDelegate);

  // axios 之类的客户端对没有 body 的 DELETE 仍会带上 application/json，
  // Fastify 默认解析器会因此抛 FST_ERR_CTP_EMPTY_JSON_BODY。空 body 应当交给路由自行校验。
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    if (typeof body !== 'string' || body.trim() === '') {
      done(null, undefined);
      return;
    }

    try {
      done(null, JSON.parse(body));
    } catch {
      done(new AppError('INVALID_JSON', 'Request body is not valid JSON'), undefined);
    }
  });

  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser(
    'text/plain',
    { parseAs: 'string', bodyLimit: configuredLimits.ingest.maxBodyBytes },
    (_request, body, done) => done(null, body),
  );

  app.addHook('onRequest', async (request, reply) => {
    markRequestStart(request);
    void reply.header('x-request-id', request.id);
  });

  // hijack 的响应不会触发这个钩子，CSV 导出自行补一条同构日志（见 domain/query/routes.ts）。
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        requestId: request.id,
        route: request.routeOptions.url ?? request.url,
        statusCode: reply.statusCode,
        durationMs: requestDurationMs(request),
      },
      'request completed',
    );
  });

  app.setErrorHandler((error, request, reply) => {
    if (isPayloadTooLarge(error)) {
      const appError = new AppError('PAYLOAD_TOO_LARGE', 'Request body exceeds the allowed size');
      return reply
        .status(ERROR_HTTP_STATUS[appError.code])
        .send(serializeError(appError, request.id));
    }

    if (isInvalidJson(error)) {
      const appError = new AppError('INVALID_JSON', 'Request body is not valid JSON');
      return reply
        .status(ERROR_HTTP_STATUS[appError.code])
        .send(serializeError(appError, request.id));
    }

    if (error instanceof AppError) {
      return reply.status(ERROR_HTTP_STATUS[error.code]).send(serializeError(error, request.id));
    }

    const clientCode = clientErrorCode(error);
    if (clientCode !== null) {
      const message =
        error instanceof Error && error.message !== '' ? error.message : 'Request was rejected';
      request.log.warn(
        {
          err: error,
          requestId: request.id,
          route: request.routeOptions.url ?? request.url,
        },
        'client request error',
      );
      return reply
        .status(ERROR_HTTP_STATUS[clientCode])
        .send(serializeError(new AppError(clientCode, message), request.id));
    }

    request.log.error(
      {
        err: error,
        stack: error instanceof Error ? error.stack : undefined,
        requestId: request.id,
        route: request.routeOptions.url ?? request.url,
      },
      'unhandled request error',
    );
    const internalError = new AppError('INTERNAL_ERROR', 'Internal server error');
    return reply.status(500).send(serializeError(internalError, request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    const appError = new AppError(
      'ROUTE_NOT_FOUND',
      `Route ${request.method} ${request.url} was not found`,
    );
    return reply.status(404).send(serializeError(appError, request.id));
  });

  await registerJwt(app);
  registerAuthRoutes(app, {
    captchaService,
    captchaRateLimiter,
    loginRateLimiter,
    userRepository: users,
  });
  registerUserRoutes(app, users);
  registerFieldTypeRoutes(app);
  registerTableRoutes(app, tables);
  registerQueryRoutes(app, tables, options.queryRouteOptions);
  registerIngestRoutes(app, tables);

  app.addHook('onClose', async () => {
    captchaService.close();
    captchaRateLimiter.close();
    loginRateLimiter.close();
  });

  app.get('/healthz', async (_request, reply) => {
    const [clickhouseResult, sqliteResult] = await Promise.allSettled([
      Promise.resolve().then(() => checkClickHouse()),
      Promise.resolve().then(() => checkSqlite()),
    ]);
    const clickhouse = clickhouseResult.status === 'fulfilled' ? 'ok' : 'error';
    const sqlite = sqliteResult.status === 'fulfilled' ? 'ok' : 'error';

    if (clickhouseResult.status === 'rejected') {
      app.log.warn({ err: clickhouseResult.reason }, 'ClickHouse health check failed');
    }
    if (sqliteResult.status === 'rejected') {
      app.log.warn({ err: sqliteResult.reason }, 'SQLite health check failed');
    }

    const payload = {
      status: clickhouse === 'ok' && sqlite === 'ok' ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor(process.uptime()),
      clickhouse,
      sqlite,
      lastReconcile: reconcileState,
    };
    return payload.status === 'ok' ? payload : reply.status(503).send(payload);
  });

  return app;
}
