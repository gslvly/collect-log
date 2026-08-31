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
    datetimeMinMs: 0,               // datetime 字段下限，1970-01-01
    datetimeMaxMs: 4102444800000,   // datetime 字段上限，2100-01-01
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
    defaultGroupLimit: 50,          // dimension.kind = 'field' 的默认 Top N
    maxGroupLimit: 1_000,           // 同上的上限
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
    captchaRateLimitPerIp: 60,      // 每分钟
  },
  schema: {
    maxFieldsPerTable: 500,
    maxEnumOptions: 200,            // 单个 enum 字段的选项数上限
    maxOptionValueBytes: 64,        // 选项 value 的 UTF-8 字节上限
    maxOptionLabelBytes: 128,       // 选项 label 的 UTF-8 字节上限
  },
} as const;
```

环境变量名一律是 `LIMIT_` + 分组 + 项名的大写下划线形式，如 `LIMIT_QUERY_MAX_RANGE_DAYS`、
`LIMIT_AUTH_CAPTCHA_RATE_LIMIT_PER_IP`。

三条补充说明：

- **`captchaRateLimitPerIp`**：`/api/auth/captcha` 是匿名接口，不限流就能被零成本刷爆进程内的
  验证码 Map。它与登录限流是两个独立的桶，阈值也不同——正常用户一次登录只取一两次验证码，
  但换验证码是合理操作，所以给得比 `loginRateLimitPerIp` 宽。
- **趋势查询按粒度收紧时间跨度**：`minute` 粒度 ≤ 2 天、`hour` 粒度 ≤ 31 天，超出返回 `INVALID_QUERY`；
  `day` 粒度不额外收紧（92 天即 92 个桶）。`maxRangeDays` 是所有查询的统一上限，但 92 天 × 分钟粒度
  是 13 万个桶，足以把响应体和前端图表一起打爆，因此在它之内再按粒度设一层。
  这两个数字**跟着粒度走、不单独提供环境变量**。
- **`maxConcurrent` 超限即拒**，返回 `RATE_LIMITED`（429），不排队（见 9.1）。
- **`maxEnumOptions` 同时是两道闸**：一是防止选项表被当成数据表用；二是守住
  `LowCardinality` 的适用前提——字典的收益随基数上升而衰减，几百个取值仍然划算，
  几万个就该改用 `string` 了（见 13）。超限返回 `INVALID_FIELD_VALUE`（400）。
- **`datetimeMinMs` / `datetimeMaxMs` 与 `occurredAt` 的窗口是两回事**，
  前者宽得多，理由见 8.2.1：业务时间字段不进分区键，写一个三年前的时间完全合理。
- **`defaultGroupLimit` / `maxGroupLimit` 只约束 `dimension.kind = 'field'`**。
  时间维度的桶数由「跨度 × 粒度」限死（见上一条），不再叠加一层 limit。

