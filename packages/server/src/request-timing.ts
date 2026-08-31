import type { FastifyRequest } from 'fastify';

const requestStartedAt = new WeakMap<object, bigint>();

export function markRequestStart(request: FastifyRequest): void {
  requestStartedAt.set(request, process.hrtime.bigint());
}

// 起点固定为 onRequest 钩子，因此 hijack 的响应自己补日志时，durationMs 与全局日志同一口径。
export function requestDurationMs(request: FastifyRequest): number {
  const startedAt = requestStartedAt.get(request);
  return startedAt === undefined ? 0 : Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}
