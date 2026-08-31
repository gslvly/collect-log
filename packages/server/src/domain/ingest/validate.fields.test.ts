import { describe, expect, it, vi } from 'vitest';

import { configuredLimits } from '../../config/limits.js';
import type { FieldRecord } from '../tables/types.js';
import {
  appError,
  definition,
  definitionFor,
  noRetiredFields,
  now,
  optionalField,
  validateFieldValues,
} from './validate.fixtures.js';
import { validateFieldValues as validateFieldValuesWithLimits } from './validate.js';

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
      expect(actual.message).toContain('Allowed fields: event_name; and 2 more');
    }
  });

  it('queries retired metadata only on the unknown-key path and identifies deprecated fields', async () => {
    const deprecated: FieldRecord = {
      key: 'legacy_name',
      label: 'Legacy name',
      type: 'string',
      required: false,
      description: '',
      options: [],
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
      options: [],
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
    ).resolves.toEqual({ event_name: 'login', is_success: null, score: null });
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

  it('treats JSON shape as the type step for all six field types', async () => {
    const enumField = optionalField(
      'channel',
      'enum',
      new Map([
        ['sms', 'SMS'],
        ['password', 'Password'],
      ]),
    );
    const cases = [
      [optionalField('text', 'string'), false],
      [enumField, false],
      [optionalField('flag', 'boolean'), 'true'],
      [optionalField('count', 'integer'), '1'],
      [optionalField('ratio', 'float'), '1.5'],
      [optionalField('happened_at', 'datetime'), '1756012830123'],
    ] as const;

    for (const [field, value] of cases) {
      await expect(
        validateFieldValues(
          { [field.key]: value },
          definitionFor(field),
          noRetiredFields,
          configuredLimits.ingest,
        ),
      ).rejects.toMatchObject({
        code: 'INVALID_FIELD_TYPE',
        field: field.key,
        expected: {
          key: field.key,
          type: field.type,
          required: false,
          ...(field.type === 'enum' ? { options: ['sms', 'password'] } : {}),
        },
        schemaVersion: 7,
      });
    }
  });

  it('completes the type step before checking any field value domain', async () => {
    const integerField = optionalField('count', 'integer');
    const datetimeField = optionalField('happened_at', 'datetime');

    await expect(
      validateFieldValues(
        { count: 1.5, happened_at: 'not-a-number' },
        definitionFor(integerField, datetimeField),
        noRetiredFields,
        configuredLimits.ingest,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_FIELD_TYPE',
      field: 'happened_at',
    });
  });

  it('accepts only active enum options and returns those options in expected', async () => {
    const enumField = optionalField(
      'channel',
      'enum',
      new Map([
        ['sms', 'SMS'],
        ['password', 'Password'],
      ]),
    );
    const enumDefinition = definitionFor(enumField);

    await expect(
      validateFieldValues(
        { channel: 'sms' },
        enumDefinition,
        noRetiredFields,
        configuredLimits.ingest,
      ),
    ).resolves.toEqual({ channel: 'sms' });

    for (const value of ['disabled_legacy', 'unknown']) {
      await expect(
        validateFieldValues(
          { channel: value },
          enumDefinition,
          noRetiredFields,
          configuredLimits.ingest,
        ),
      ).rejects.toMatchObject({
        code: 'INVALID_FIELD_VALUE',
        field: 'channel',
        expected: {
          key: 'channel',
          type: 'enum',
          required: false,
          options: ['sms', 'password'],
        },
        schemaVersion: 7,
      });
    }
  });

  it('truncates enum expected.options at maxEnumOptions and reports the omitted count', async () => {
    const enumField = optionalField(
      'channel',
      'enum',
      new Map([
        ['sms', 'SMS'],
        ['password', 'Password'],
        ['passkey', 'Passkey'],
      ]),
    );

    try {
      await validateFieldValuesWithLimits(
        { channel: 'unknown' },
        definitionFor(enumField),
        noRetiredFields,
        configuredLimits.ingest,
        { ...configuredLimits.schema, maxEnumOptions: 2 },
      );
      throw new Error('Expected enum value validation to fail');
    } catch (error) {
      const actual = appError(error);
      expect(actual).toMatchObject({
        code: 'INVALID_FIELD_VALUE',
        expected: { options: ['sms', 'password'] },
      });
      expect(actual.message).toContain('expected.options omits 1 more');
    }
  });

  it('validates integer precision in the value-domain step', async () => {
    const integerField = optionalField('count', 'integer');
    const integerDefinition = definitionFor(integerField);

    for (const value of [Number.MIN_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER]) {
      await expect(
        validateFieldValues(
          { count: value },
          integerDefinition,
          noRetiredFields,
          configuredLimits.ingest,
        ),
      ).resolves.toEqual({ count: value });
    }

    for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
      await expect(
        validateFieldValues(
          { count: value },
          integerDefinition,
          noRetiredFields,
          configuredLimits.ingest,
        ),
      ).rejects.toMatchObject({
        code: 'INVALID_FIELD_VALUE',
        field: 'count',
        expected: { key: 'count', type: 'integer', required: false },
        schemaVersion: 7,
      });
    }
  });

  it('accepts every finite float and rejects non-finite numbers in the value-domain step', async () => {
    for (const value of [0, -12.5, Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE]) {
      await expect(
        validateFieldValues(
          { event_name: 'score', score: value },
          definition,
          noRetiredFields,
          configuredLimits.ingest,
        ),
      ).resolves.toEqual({ event_name: 'score', is_success: null, score: value });
    }

    for (const value of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      await expect(
        validateFieldValues(
          { event_name: 'score', score: value },
          definition,
          noRetiredFields,
          configuredLimits.ingest,
        ),
      ).rejects.toMatchObject({
        code: 'INVALID_FIELD_VALUE',
        field: 'score',
        expected: { key: 'score', type: 'float', required: false },
        schemaVersion: 7,
      });
    }
  });

  it('validates integer-millisecond datetime values against inclusive configured bounds', async () => {
    const datetimeField = optionalField('happened_at', 'datetime');
    const datetimeDefinition = definitionFor(datetimeField);

    for (const value of [
      configuredLimits.ingest.datetimeMinMs,
      now,
      configuredLimits.ingest.datetimeMaxMs,
    ]) {
      await expect(
        validateFieldValues(
          { happened_at: value },
          datetimeDefinition,
          noRetiredFields,
          configuredLimits.ingest,
        ),
      ).resolves.toEqual({ happened_at: value });
    }

    for (const value of [
      configuredLimits.ingest.datetimeMinMs - 1,
      now + 0.5,
      configuredLimits.ingest.datetimeMaxMs + 1,
    ]) {
      await expect(
        validateFieldValues(
          { happened_at: value },
          datetimeDefinition,
          noRetiredFields,
          configuredLimits.ingest,
        ),
      ).rejects.toMatchObject({
        code: 'INVALID_FIELD_VALUE',
        field: 'happened_at',
        expected: { key: 'happened_at', type: 'datetime', required: false },
        schemaVersion: 7,
      });
    }
  });
});
