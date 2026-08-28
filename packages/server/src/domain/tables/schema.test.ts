import { describe, expect, it } from 'vitest';

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
    expect(() => validateInitialFields([field('one'), field('two')], 1)).toThrow(
      expect.objectContaining({ code: 'TOO_MANY_FIELDS' }),
    );
  });

  it('rejects duplicate field keys inside a single create request', () => {
    expect(() => validateInitialFields([field('dup'), field('dup')], 10)).toThrow(
      expect.objectContaining({ code: 'FIELD_KEY_EXISTS' }),
    );
  });

  it('maps only string and boolean to their nullable ClickHouse types', () => {
    expect(physicalTypeFor('string')).toBe('Nullable(String)');
    expect(physicalTypeFor('boolean')).toBe('Nullable(Bool)');
    expect(() => physicalTypeFor('number' as FieldType)).toThrow(
      expect.objectContaining({ code: 'INVALID_JSON' }),
    );
  });

  it('generates the DESIGN 6.5 physical DDL from validated identifiers', () => {
    expect(
      buildPhysicalTableDdl('collect_a8f31c', [
        field('user_id'),
        field('is_new_device', 'boolean'),
      ]),
    ).toBe(`CREATE TABLE IF NOT EXISTS data.collect_a8f31c
(
    \`_record_id\`      UUID,
    \`_schema_version\` UInt32,
    \`_occurred_at\`    DateTime64(3, 'UTC'),
    \`_received_at\`    DateTime64(3, 'UTC') DEFAULT now64(3),
    \`user_id\` Nullable(String),
    \`is_new_device\` Nullable(Bool)
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
