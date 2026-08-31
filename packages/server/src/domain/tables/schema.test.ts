import { describe, expect, it } from 'vitest';

import { configuredLimits } from '../../config/limits.js';
import {
  assertValidFieldKey,
  buildPhysicalTableDdl,
  physicalTypeFor,
  validateInitialFields,
} from './schema.js';
import type { CreateFieldInput, FieldType } from './types.js';

function field(key: string, type: FieldType = 'string'): CreateFieldInput {
  return { key, label: key, type, required: false, description: '' };
}

describe('collection table schema', () => {
  it('accepts only DESIGN 5.2 field keys', () => {
    expect(assertValidFieldKey('a')).toBe('a');
    expect(assertValidFieldKey('login_method')).toBe('login_method');
    expect(assertValidFieldKey(`a${'0'.repeat(63)}`)).toHaveLength(64);

    for (const invalid of ['', '_private', 'Uppercase', '1st', 'has-dash', `a${'0'.repeat(64)}`]) {
      expect(() => assertValidFieldKey(invalid)).toThrow(
        expect.objectContaining({ code: 'INVALID_FIELD_KEY' }),
      );
    }
  });

  it('enforces the configured field limit', () => {
    expect(() =>
      validateInitialFields([field('one'), field('two')], {
        ...configuredLimits.schema,
        maxFieldsPerTable: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'TOO_MANY_FIELDS' }));
  });

  it('rejects duplicate field keys inside a single create request', () => {
    expect(() =>
      validateInitialFields([field('dup'), field('dup')], configuredLimits.schema),
    ).toThrow(expect.objectContaining({ code: 'FIELD_KEY_EXISTS' }));
  });

  it('maps every field type to its nullable ClickHouse type', () => {
    expect(physicalTypeFor('string')).toBe('Nullable(String)');
    expect(physicalTypeFor('enum')).toBe('LowCardinality(Nullable(String))');
    expect(physicalTypeFor('boolean')).toBe('Nullable(Bool)');
    expect(physicalTypeFor('integer')).toBe('Nullable(Int64)');
    expect(physicalTypeFor('float')).toBe('Nullable(Float64)');
    expect(physicalTypeFor('datetime')).toBe("Nullable(DateTime64(3, 'UTC'))");
    expect(() => physicalTypeFor('decimal' as FieldType)).toThrow(
      expect.objectContaining({ code: 'INVALID_JSON' }),
    );
  });

  it('requires active options only for enum fields', () => {
    const activeOption = { value: 'wechat', label: '微信', status: 'active' as const };
    expect(() =>
      validateInitialFields(
        [{ ...field('channel', 'enum'), options: [activeOption] }],
        configuredLimits.schema,
      ),
    ).not.toThrow();

    for (const invalid of [
      field('channel', 'enum'),
      {
        ...field('channel', 'enum'),
        options: [{ ...activeOption, status: 'disabled' as const }],
      },
      { ...field('event_name'), options: [activeOption] },
      { ...field('channel', 'enum'), options: [activeOption, activeOption] },
    ]) {
      expect(() => validateInitialFields([invalid], configuredLimits.schema)).toThrow(
        expect.objectContaining({ code: 'INVALID_FIELD_VALUE' }),
      );
    }
  });

  it('enforces configured enum option count, value bytes and label bytes', () => {
    const option = (value: string, label: string) => ({
      value,
      label,
      status: 'active' as const,
    });
    const schemaLimits = {
      ...configuredLimits.schema,
      maxEnumOptions: 2,
      maxOptionValueBytes: 3,
      maxOptionLabelBytes: 3,
    };
    const invalidOptions = [
      [option('a', 'A'), option('b', 'B'), option('c', 'C')],
      [option('toolong', 'A')],
      [option('a', '微信')],
    ];

    for (const options of invalidOptions) {
      expect(() =>
        validateInitialFields([{ ...field('channel', 'enum'), options }], schemaLimits),
      ).toThrow(expect.objectContaining({ code: 'INVALID_FIELD_VALUE', field: 'channel' }));
    }
  });

  it('generates the DESIGN 6.5 physical DDL from validated identifiers', () => {
    expect(
      buildPhysicalTableDdl('collect_a8f31c', [
        field('user_id'),
        field('channel', 'enum'),
        field('is_new_device', 'boolean'),
        field('retry_count', 'integer'),
        field('score', 'float'),
        field('registered_at', 'datetime'),
      ]),
    ).toBe(`CREATE TABLE IF NOT EXISTS data.collect_a8f31c
(
    \`_record_id\`      UUID,
    \`_schema_version\` UInt32,
    \`_occurred_at\`    DateTime64(3, 'UTC'),
    \`_received_at\`    DateTime64(3, 'UTC') DEFAULT now64(3),
    \`user_id\` Nullable(String),
    \`channel\` LowCardinality(Nullable(String)),
    \`is_new_device\` Nullable(Bool),
    \`retry_count\` Nullable(Int64),
    \`score\` Nullable(Float64),
    \`registered_at\` Nullable(DateTime64(3, 'UTC'))
)
ENGINE = ReplacingMergeTree(_received_at)
PARTITION BY toYYYYMM(_occurred_at)
ORDER BY
(
    toDate(_occurred_at),
    _occurred_at,
    _record_id
);`);
  });

  it('rejects untrusted table and column identifiers before constructing DDL', () => {
    expect(() => buildPhysicalTableDdl('collect_safe; DROP TABLE meta.collect_tables', [])).toThrow(
      'Invalid ClickHouse identifier',
    );
    expect(() => buildPhysicalTableDdl('collect_safe', [field('unsafe-key')])).toThrow();
  });
});
