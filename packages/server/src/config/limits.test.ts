import { describe, expect, it } from 'vitest';

import { limits, loadLimits } from './limits.js';

describe('limits', () => {
  it('matches the DESIGN appendix A defaults plus the implementation-level captcha rate limit', () => {
    expect(limits).toEqual({
      ingest: {
        maxBodyBytes: 65_536,
        maxPayloadBytes: 32_768,
        maxFields: 100,
        maxStringLength: 4_096,
        occurredAtPastMs: 604_800_000,
        occurredAtFutureMs: 300_000,
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
      },
    });
  });

  it('allows individual defaults to be overridden through environment variables', () => {
    expect(loadLimits({ LIMIT_QUERY_MAX_ROWS: '250' })).toMatchObject({
      query: { maxRows: 250 },
      ingest: { maxBodyBytes: limits.ingest.maxBodyBytes },
    });
  });
});
