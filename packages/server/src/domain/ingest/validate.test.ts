import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { configuredLimits } from '../../config/limits.js';
import { AppError } from '../../errors.js';
import { appError, now } from './validate.fixtures.js';
import { parsePayload } from './validate.js';

describe('ingest payload parsing', () => {
  it('generates a recordId and accepts inclusive occurredAt boundaries', () => {
    const generated = randomUUID();
    const lower = parsePayload(
      JSON.stringify({
        occurredAt: now - configuredLimits.ingest.occurredAtPastMs,
        data: {},
      }),
      now,
      configuredLimits.ingest,
      () => generated,
    );
    const upper = parsePayload(
      JSON.stringify({
        occurredAt: now + configuredLimits.ingest.occurredAtFutureMs,
        data: {},
      }),
      now,
      configuredLimits.ingest,
    );

    expect(lower.recordId).toBe(generated);
    expect(lower.occurredAt).toBe(now - configuredLimits.ingest.occurredAtPastMs);
    expect(upper.occurredAt).toBe(now + configuredLimits.ingest.occurredAtFutureMs);
  });

  it.each([
    now - configuredLimits.ingest.occurredAtPastMs - 1,
    now + configuredLimits.ingest.occurredAtFutureMs + 1,
    Number.NaN,
  ])('rejects occurredAt outside the allowed range: %s', (occurredAt) => {
    const raw = Number.isNaN(occurredAt)
      ? '{"recordId":"00000000-0000-4000-8000-000000000000","occurredAt":null,"data":{}}'
      : JSON.stringify({ recordId: randomUUID(), occurredAt, data: {} });
    try {
      parsePayload(raw, now, configuredLimits.ingest);
      throw new Error('Expected occurredAt validation to fail');
    } catch (error) {
      expect(appError(error).code).toBe('INVALID_OCCURRED_AT');
    }
  });

  it('rejects malformed payload JSON and non-object data, and accepts any UUID version', () => {
    expect(() => parsePayload('{', now, configuredLimits.ingest)).toThrowError(AppError);
    try {
      parsePayload(JSON.stringify({ occurredAt: now, data: [] }), now, configuredLimits.ingest);
    } catch (error) {
      expect(appError(error).code).toBe('INVALID_ENVELOPE');
    }
    try {
      parsePayload(
        JSON.stringify({ recordId: 'not-a-uuid', occurredAt: now, data: {} }),
        now,
        configuredLimits.ingest,
      );
    } catch (error) {
      expect(appError(error).code).toBe('INVALID_RECORD_ID');
    }

    // DESIGN 8.2 只要求「合法 UUID」：v1 / v7 这类非 v4 的稳定 ID 必须被接受。
    const uuidV7 = '01920a3c-8f2e-7c1d-9b4a-0123456789ab';
    expect(
      parsePayload(
        JSON.stringify({ recordId: uuidV7, occurredAt: now, data: {} }),
        now,
        configuredLimits.ingest,
      ).recordId,
    ).toBe(uuidV7);
  });

  it('rejects payloads with more than the configured number of data keys', () => {
    try {
      parsePayload(
        JSON.stringify({
          recordId: randomUUID(),
          occurredAt: now,
          data: { first: 'one', second: 'two' },
        }),
        now,
        { ...configuredLimits.ingest, maxFields: 1 },
      );
      throw new Error('Expected field count validation to fail');
    } catch (error) {
      expect(appError(error).code).toBe('TOO_MANY_FIELDS');
    }
  });
});
