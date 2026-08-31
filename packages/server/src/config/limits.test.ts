import { describe, expect, it } from 'vitest';

import { limits, loadLimits } from './limits.js';

describe('limits', () => {
  it('matches the DESIGN appendix A defaults', () => {
    expect(limits).toEqual({
      ingest: {
        maxBodyBytes: 65_536,
        maxPayloadBytes: 32_768,
        maxFields: 100,
        maxStringLength: 4_096,
        occurredAtPastMs: 604_800_000,
        occurredAtFutureMs: 300_000,
        datetimeMinMs: 0,
        datetimeMaxMs: 4_102_444_800_000,
        signatureWindowMs: 300_000,
        nonceCacheSize: 100_000,
        rateLimitPerIp: 100,
        rateLimitPerTable: 1_000,
      },
      query: {
        maxRangeDays: 92,
        maxRows: 10_000,
        maxConditions: 32,
        maxNestingDepth: 4,
        maxExecutionTimeSec: 10,
        maxMemoryUsageBytes: 2_147_483_648,
        maxConcurrent: 8,
        defaultGroupLimit: 50,
        maxGroupLimit: 1_000,
      },
      export: {
        maxRows: 1_000_000,
        maxExecutionTimeSec: 120,
        maxConcurrent: 2,
      },
      auth: {
        tokenTtlSec: 43_200,
        captchaTtlSec: 120,
        loginRateLimitPerIp: 10,
        captchaRateLimitPerIp: 60,
      },
      schema: {
        maxFieldsPerTable: 500,
        maxEnumOptions: 200,
        maxOptionValueBytes: 64,
        maxOptionLabelBytes: 128,
      },
    });
  });

  it('allows individual defaults to be overridden through environment variables', () => {
    expect(
      loadLimits({
        LIMIT_INGEST_DATETIME_MIN_MS: '0',
        LIMIT_QUERY_MAX_ROWS: '250',
        LIMIT_QUERY_DEFAULT_GROUP_LIMIT: '25',
        LIMIT_SCHEMA_MAX_ENUM_OPTIONS: '100',
      }),
    ).toMatchObject({
      ingest: { datetimeMinMs: 0, maxBodyBytes: limits.ingest.maxBodyBytes },
      query: { maxRows: 250, defaultGroupLimit: 25 },
      schema: { maxEnumOptions: 100 },
    });
  });

  it('allows zero only for the datetime lower bound', () => {
    expect(() => loadLimits({ LIMIT_INGEST_DATETIME_MIN_MS: '-1' })).toThrow(
      'LIMIT_INGEST_DATETIME_MIN_MS must be a non-negative safe integer',
    );
    expect(() => loadLimits({ LIMIT_QUERY_DEFAULT_GROUP_LIMIT: '0' })).toThrow(
      'LIMIT_QUERY_DEFAULT_GROUP_LIMIT must be a positive safe integer',
    );
  });
});
