## 附录 A：限额配置

所有限额**写在配置文件里，不入库**，随部署环境调整，通过环境变量覆盖。

```ts
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
  },
  schema: {
    maxFieldsPerTable: 500,
  },
} as const;
```

