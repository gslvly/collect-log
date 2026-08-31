import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { configuredLimits } from '../../config/limits.js';
import { post, schemaVersion, signedRequest, storedRows } from './ingest.integration.fixtures.js';

describe('stage C ingest route', () => {
  it('returns schema-aware errors for unknown and deprecated fields', async () => {
    const occurredAt = Date.now();
    const unknown = await post(
      signedRequest({
        recordId: randomUUID(),
        occurredAt,
        data: { event_name: 'x', mystery: 'value' },
      }),
    );
    const deprecated = await post(
      signedRequest({
        recordId: randomUUID(),
        occurredAt,
        data: { event_name: 'x', legacy_value: 'value' },
      }),
    );

    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({
      error: {
        code: 'UNKNOWN_FIELD',
        field: 'mystery',
        schemaVersion,
      },
    });
    expect(unknown.json().error.message).toContain('channel, event_name, is_success');
    expect(unknown.json().error).not.toHaveProperty('expected');

    expect(deprecated.statusCode).toBe(400);
    expect(deprecated.json()).toMatchObject({
      error: {
        code: 'DEPRECATED_FIELD',
        field: 'legacy_value',
        expected: {
          key: 'legacy_value',
          label: 'Legacy value',
          type: 'string',
          required: false,
        },
        schemaVersion,
      },
    });
  });

  it('returns schema-aware errors for required, type and UTF-8 length violations', async () => {
    const occurredAt = Date.now();
    const cases = [
      {
        request: signedRequest({
          recordId: randomUUID(),
          occurredAt,
          data: { is_success: true },
        }),
        code: 'REQUIRED_FIELD_MISSING',
      },
      {
        request: signedRequest({
          recordId: randomUUID(),
          occurredAt,
          data: { event_name: false },
        }),
        code: 'INVALID_FIELD_TYPE',
      },
      {
        request: signedRequest({
          recordId: randomUUID(),
          occurredAt,
          data: { event_name: 'x'.repeat(configuredLimits.ingest.maxStringLength + 1) },
        }),
        code: 'FIELD_VALUE_TOO_LONG',
      },
    ];

    for (const testCase of cases) {
      const response = await post(testCase.request);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: testCase.code,
          field: 'event_name',
          expected: {
            key: 'event_name',
            label: 'Event name',
            type: 'string',
            required: true,
          },
          schemaVersion,
        },
      });
    }
  });

  it('accepts finite float values beyond the safe-integer range and rejects non-numeric shapes', async () => {
    const recordId = randomUUID();
    const score = Number.MAX_SAFE_INTEGER + 1;
    const accepted = await post(
      signedRequest({
        recordId,
        occurredAt: Date.now(),
        data: { event_name: 'scored', score },
      }),
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
    await expect(storedRows(recordId)).resolves.toEqual([
      expect.objectContaining({ record_id: recordId, score }),
    ]);

    const response = await post(
      signedRequest({
        recordId: randomUUID(),
        occurredAt: Date.now(),
        data: { event_name: 'scored', score: '12.5' },
      }),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'INVALID_FIELD_TYPE',
        field: 'score',
        expected: { key: 'score', label: 'Score', type: 'float', required: false },
        schemaVersion,
      },
    });
  });

  it('rejects disabled enum options with active expected.options only', async () => {
    const response = await post(
      signedRequest({
        recordId: randomUUID(),
        occurredAt: Date.now(),
        data: { event_name: 'login', channel: 'legacy' },
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'INVALID_FIELD_VALUE',
        field: 'channel',
        expected: {
          key: 'channel',
          label: 'Channel',
          type: 'enum',
          required: false,
          options: ['sms', 'password'],
        },
        schemaVersion,
      },
    });
  });

  it('distinguishes integer and datetime shape errors from value-domain errors', async () => {
    const cases = [
      { field: 'retry_count', value: '1', code: 'INVALID_FIELD_TYPE' },
      { field: 'retry_count', value: 1.5, code: 'INVALID_FIELD_VALUE' },
      {
        field: 'retry_count',
        value: Number.MAX_SAFE_INTEGER + 1,
        code: 'INVALID_FIELD_VALUE',
      },
      { field: 'registered_at', value: '0', code: 'INVALID_FIELD_TYPE' },
      {
        field: 'registered_at',
        value: configuredLimits.ingest.datetimeMinMs - 1,
        code: 'INVALID_FIELD_VALUE',
      },
      { field: 'registered_at', value: Date.now() + 0.5, code: 'INVALID_FIELD_VALUE' },
      {
        field: 'registered_at',
        value: configuredLimits.ingest.datetimeMaxMs + 1,
        code: 'INVALID_FIELD_VALUE',
      },
    ] as const;

    for (const testCase of cases) {
      const response = await post(
        signedRequest({
          recordId: randomUUID(),
          occurredAt: Date.now(),
          data: { event_name: 'typed', [testCase.field]: testCase.value },
        }),
      );
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: testCase.code,
          field: testCase.field,
          expected: {
            key: testCase.field,
            type: testCase.field === 'retry_count' ? 'integer' : 'datetime',
            required: false,
          },
          schemaVersion,
        },
      });
    }
  });
});
