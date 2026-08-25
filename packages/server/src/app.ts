import cors, { type FastifyCorsOptionsDelegate } from '@fastify/cors';
import Fastify, { LogController } from 'fastify';
import { ulid } from 'ulid';

import { env } from './config/env.js';
import { configuredLimits } from './config/limits.js';
import { CaptchaService } from './domain/auth/captcha.js';
import { registerJwt } from './domain/auth/jwt.js';
import { CaptchaRateLimiter, LoginRateLimiter } from './domain/auth/rate-limit.js';
import { registerAuthRoutes } from './domain/auth/routes.js';
import { userRepository, type UserRepository } from './domain/users/repository.js';
import { registerUserRoutes } from './domain/users/routes.js';
import { AppError, ERROR_HTTP_STATUS, serializeError, type ErrorCode } from './errors.js';
import { pingClickHouse } from './infra/clickhouse.js';
import { reconcileState } from './reconcile-state.js';

const requestStartedAt = new WeakMap<object, bigint>();

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
  userRepository?: UserRepository;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const captchaService = options.captchaService ?? new CaptchaService();
  const captchaRateLimiter = options.captchaRateLimiter ?? new CaptchaRateLimiter();
  const loginRateLimiter = options.loginRateLimiter ?? new LoginRateLimiter();
  const checkClickHouse = options.pingClickHouse ?? pingClickHouse;
  const users = options.userRepository ?? userRepository;
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
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

    const allowedOrigins = request.url.startsWith('/api/ingest/')
      ? env.INGEST_ALLOWED_ORIGINS
      : env.CONSOLE_ALLOWED_ORIGINS;
    callback(null, { origin: allowedOrigins });
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
    requestStartedAt.set(request, process.hrtime.bigint());
    void reply.header('x-request-id', request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    const startedAt = requestStartedAt.get(request);
    const durationMs =
      startedAt === undefined ? 0 : Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    request.log.info(
      {
        requestId: request.id,
        route: request.routeOptions.url ?? request.url,
        statusCode: reply.statusCode,
        durationMs,
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

  app.addHook('onClose', async () => {
    captchaService.close();
    captchaRateLimiter.close();
    loginRateLimiter.close();
  });

  app.get('/healthz', async (_request, reply) => {
    try {
      await checkClickHouse();
      return {
        status: 'ok',
        uptimeSeconds: Math.floor(process.uptime()),
        clickhouse: 'ok',
        lastReconcile: reconcileState,
      };
    } catch (error) {
      app.log.warn({ err: error }, 'ClickHouse health check failed');
      return reply.status(503).send({
        status: 'degraded',
        uptimeSeconds: Math.floor(process.uptime()),
        clickhouse: 'error',
        lastReconcile: reconcileState,
      });
    }
  });

  return app;
}
