// src/config/limits.ts
export const limits = {
  ingest: {
    maxBodyBytes: 64 * 1024,        // envelope 整体大小上限
    maxPayloadBytes: 32 * 1024,     // 解码后 d 字段大小上限
    maxFields: 100,                 // 单次上报字段数上限
    maxStringLength: 4096,          // 单个字符串字段长度上限
    occurredAtPastMs: 7 * 24 * 3600 * 1000,
    occurredAtFutureMs: 5 * 60 * 1000,
    signatureWindowMs: 5 * 60 * 1000,
    nonceCacheSize: 100_000,
    rateLimitPerIp: 100,            // 每秒
    rateLimitPerTable: 1000,        // 每秒
  },
  query: {
    maxRangeDays: 92,
    maxRows: 10_000,
    maxConditions: 32,
    maxNestingDepth: 4,
    maxExecutionTimeSec: 10,
    maxMemoryUsageBytes: 2 * 1024 * 1024 * 1024,
    maxConcurrent: 8,
  },
  export: {
    maxRows: 1_000_000,
    maxExecutionTimeSec: 120,
    maxConcurrent: 2,
  },
  auth: {
    tokenTtlSec: 12 * 3600,
    captchaTtlSec: 120,
    loginRateLimitPerIp: 10,        // 每分钟
    captchaRateLimitPerIp: 60,      // 每分钟（DESIGN 附录 A 未定义，实现层补充）
  },
  schema: {
    maxFieldsPerTable: 500,
  },
} as const;

type NumericConfig<T> = {
  [Key in keyof T]: T[Key] extends Record<string, number>
    ? { [NestedKey in keyof T[Key]]: number }
    : never;
};

export type Limits = NumericConfig<typeof limits>;

const overrideNames = {
  ingest: {
    maxBodyBytes: 'LIMIT_INGEST_MAX_BODY_BYTES',
    maxPayloadBytes: 'LIMIT_INGEST_MAX_PAYLOAD_BYTES',
    maxFields: 'LIMIT_INGEST_MAX_FIELDS',
    maxStringLength: 'LIMIT_INGEST_MAX_STRING_LENGTH',
    occurredAtPastMs: 'LIMIT_INGEST_OCCURRED_AT_PAST_MS',
    occurredAtFutureMs: 'LIMIT_INGEST_OCCURRED_AT_FUTURE_MS',
    signatureWindowMs: 'LIMIT_INGEST_SIGNATURE_WINDOW_MS',
    nonceCacheSize: 'LIMIT_INGEST_NONCE_CACHE_SIZE',
    rateLimitPerIp: 'LIMIT_INGEST_RATE_LIMIT_PER_IP',
    rateLimitPerTable: 'LIMIT_INGEST_RATE_LIMIT_PER_TABLE',
  },
  query: {
    maxRangeDays: 'LIMIT_QUERY_MAX_RANGE_DAYS',
    maxRows: 'LIMIT_QUERY_MAX_ROWS',
    maxConditions: 'LIMIT_QUERY_MAX_CONDITIONS',
    maxNestingDepth: 'LIMIT_QUERY_MAX_NESTING_DEPTH',
    maxExecutionTimeSec: 'LIMIT_QUERY_MAX_EXECUTION_TIME_SEC',
    maxMemoryUsageBytes: 'LIMIT_QUERY_MAX_MEMORY_USAGE_BYTES',
    maxConcurrent: 'LIMIT_QUERY_MAX_CONCURRENT',
  },
  export: {
    maxRows: 'LIMIT_EXPORT_MAX_ROWS',
    maxExecutionTimeSec: 'LIMIT_EXPORT_MAX_EXECUTION_TIME_SEC',
    maxConcurrent: 'LIMIT_EXPORT_MAX_CONCURRENT',
  },
  auth: {
    tokenTtlSec: 'LIMIT_AUTH_TOKEN_TTL_SEC',
    captchaTtlSec: 'LIMIT_AUTH_CAPTCHA_TTL_SEC',
    loginRateLimitPerIp: 'LIMIT_AUTH_LOGIN_RATE_LIMIT_PER_IP',
    captchaRateLimitPerIp: 'LIMIT_AUTH_CAPTCHA_RATE_LIMIT_PER_IP',
  },
  schema: {
    maxFieldsPerTable: 'LIMIT_SCHEMA_MAX_FIELDS_PER_TABLE',
  },
} as const;

function positiveInteger(source: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = source[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer, received "${raw}"`);
  }
  return value;
}

export function loadLimits(source: NodeJS.ProcessEnv = process.env): Limits {
  const groups = Object.keys(limits) as Array<keyof typeof limits>;
  const loaded = {} as Limits;

  for (const group of groups) {
    const values = limits[group];
    const names = overrideNames[group];
    const result: Record<string, number> = {};

    for (const key of Object.keys(values)) {
      const typedKey = key as keyof typeof values;
      result[key] = positiveInteger(source, names[typedKey], values[typedKey]);
    }

    Object.assign(loaded, { [group]: result });
  }

  return loaded;
}

export const configuredLimits = loadLimits();
