import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { configuredLimits } from '../../config/limits.js';
import { AppError } from '../../errors.js';
import type { ActiveField, FieldRecord } from '../tables/types.js';
import { parsePayload, validateFieldValues } from './validate.js';

const now = 1_756_012_830_123;
const fields: ActiveField[] = [
  {
    key: 'event_name',
    label: 'Event name',
    type: 'string',
    required: true,
    description: '',
    schemaVersion: 7,
  },
  {
    key: 'is_success',
    label: 'Success',
    type: 'boolean',
    required: false,
    description: '',
    schemaVersion: 7,
  },
];
const definition = {
  projectId: 'prj_01KABCDEF0123456789ABCDEFG',
  schemaVersion: 7,
  fields,
};
const noRetiredFields = async (): Promise<FieldRecord[]> => [];

function appError(error: unknown): AppError {
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

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

describe('ingest field validation', () => {
  it('validates unknown fields before active-field type errors with stable key order', async () => {
    const listFields = vi.fn(noRetiredFields);

    await expect(
      validateFieldValues(
        { unexpected: 'value', event_name: false },
        definition,
        listFields,
        configuredLimits.ingest,
      ),
    ).rejects.toMatchObject({
      code: 'UNKNOWN_FIELD',
      field: 'unexpected',
      schemaVersion: 7,
      expected: undefined,
    });
    expect(listFields).toHaveBeenCalledOnce();

    try {
      await validateFieldValues(
        { unexpected: 'value', event_name: false },
        definition,
        noRetiredFields,
        configuredLimits.ingest,
      );
    } catch (error) {
      expect(appError(error).message).toContain('event_name, is_success');
    }
  });

  it('truncates the allowed-key list and reports the remaining count', async () => {
    try {
      await validateFieldValues({ unexpected: 'value' }, definition, noRetiredFields, {
        ...configuredLimits.ingest,
        maxFields: 1,
      });
      throw new Error('Expected unknown field validation to fail');
    } catch (error) {
      const actual = appError(error);
      expect(actual.code).toBe('UNKNOWN_FIELD');
      expect(actual.message).toContain('Allowed fields: event_name; and 1 more');
    }
  });

  it('queries retired metadata only on the unknown-key path and identifies deprecated fields', async () => {
    const deprecated: FieldRecord = {
      key: 'legacy_name',
      label: 'Legacy name',
      type: 'string',
      required: false,
      description: '',
      status: 'deprecated',
      renamedTo: '',
      schemaVersion: 6,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    const listFields = vi.fn(async () => [deprecated]);

    await expect(
      validateFieldValues(
        { event_name: 'login', legacy_name: 'old' },
        definition,
        listFields,
        configuredLimits.ingest,
      ),
    ).rejects.toMatchObject({
      code: 'DEPRECATED_FIELD',
      field: 'legacy_name',
      expected: {
        key: 'legacy_name',
        label: 'Legacy name',
        type: 'string',
        required: false,
      },
      schemaVersion: 7,
    });
    expect(listFields).toHaveBeenCalledOnce();
  });

  it('treats dropped and renamed keys as unknown', async () => {
    const retired = (status: 'dropped' | 'renamed'): FieldRecord => ({
      key: 'old_name',
      label: 'Old name',
      type: 'string',
      required: false,
      description: '',
      status,
      renamedTo: status === 'renamed' ? 'event_name' : '',
      schemaVersion: 6,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });

    for (const status of ['dropped', 'renamed'] as const) {
      await expect(
        validateFieldValues(
          { event_name: 'login', old_name: 'old' },
          definition,
          async () => [retired(status)],
          configuredLimits.ingest,
        ),
      ).rejects.toMatchObject({ code: 'UNKNOWN_FIELD', field: 'old_name' });
    }
  });

  it('treats null as unsubmitted, writes optional null and rejects missing required fields', async () => {
    const listFields = vi.fn(noRetiredFields);
    await expect(
      validateFieldValues(
        { event_name: 'login', is_success: null, ignored_unknown: null },
        definition,
        listFields,
        configuredLimits.ingest,
      ),
    ).resolves.toEqual({ event_name: 'login', is_success: null });
    expect(listFields).not.toHaveBeenCalled();

    await expect(
      validateFieldValues(
        { event_name: null },
        definition,
        noRetiredFields,
        configuredLimits.ingest,
      ),
    ).rejects.toMatchObject({
      code: 'REQUIRED_FIELD_MISSING',
      field: 'event_name',
      expected: { key: 'event_name', type: 'string', required: true },
      schemaVersion: 7,
    });
  });

  it('returns self-describing type and UTF-8 byte-length errors', async () => {
    await expect(
      validateFieldValues(
        { event_name: false },
        definition,
        noRetiredFields,
        configuredLimits.ingest,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_FIELD_TYPE',
      field: 'event_name',
      expected: { key: 'event_name', type: 'string', required: true },
      schemaVersion: 7,
    });

    await expect(
      validateFieldValues({ event_name: '中' }, definition, noRetiredFields, {
        ...configuredLimits.ingest,
        maxStringLength: 2,
      }),
    ).rejects.toMatchObject({
      code: 'FIELD_VALUE_TOO_LONG',
      field: 'event_name',
      expected: { key: 'event_name', type: 'string', required: true },
      schemaVersion: 7,
    });
  });
});
