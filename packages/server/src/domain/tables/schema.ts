import { AppError } from '../../errors.js';
import { assertIdentifier } from '../../infra/clickhouse.js';
import type { CreateFieldInput, FieldType } from './types.js';

export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const PHYSICAL_TYPES: Readonly<Record<FieldType, string>> = {
  string: 'Nullable(String)',
  boolean: 'Nullable(Bool)',
};

export function assertValidFieldKey(fieldKey: string): string {
  if (!FIELD_KEY_PATTERN.test(fieldKey)) {
    throw new AppError(
      'INVALID_FIELD_KEY',
      `Field key "${fieldKey}" must match ${FIELD_KEY_PATTERN.source}`,
      { field: fieldKey },
    );
  }
  return assertIdentifier(fieldKey);
}

export function physicalTypeFor(fieldType: FieldType): string {
  const physicalType = PHYSICAL_TYPES[fieldType];
  if (physicalType === undefined) {
    throw new AppError('INVALID_JSON', `Unsupported field type "${String(fieldType)}"`);
  }
  return physicalType;
}

export function validateInitialFields(
  fields: readonly CreateFieldInput[],
  maxFieldsPerTable: number,
): void {
  if (fields.length > maxFieldsPerTable) {
    throw new AppError('TOO_MANY_FIELDS', `A table may define at most ${maxFieldsPerTable} fields`);
  }

  const seen = new Set<string>();
  for (const field of fields) {
    assertValidFieldKey(field.key);
    physicalTypeFor(field.type);
    if (seen.has(field.key)) {
      throw new AppError('FIELD_KEY_EXISTS', `Field key "${field.key}" is duplicated`);
    }
    seen.add(field.key);
  }
}

export function buildPhysicalTableDdl(
  physicalName: string,
  fields: readonly Pick<CreateFieldInput, 'key' | 'type'>[],
): string {
  const safePhysicalName = assertIdentifier(physicalName);
  const customColumns = fields.map((field) => {
    const safeFieldKey = assertValidFieldKey(field.key);
    return `    \`${safeFieldKey}\` ${physicalTypeFor(field.type)}`;
  });
  const columns = [
    '    `_record_id`      UUID',
    '    `_schema_version` UInt32',
    "    `_occurred_at`    DateTime64(3, 'UTC')",
    "    `_received_at`    DateTime64(3, 'UTC') DEFAULT now64(3)",
    ...customColumns,
  ];

  return `CREATE TABLE IF NOT EXISTS data.${safePhysicalName}
(
${columns.join(',\n')}
)
ENGINE = ReplacingMergeTree(_received_at)
PARTITION BY toYYYYMM(_occurred_at)
ORDER BY
(
    toDate(_occurred_at),
    _occurred_at,
    _record_id
);`;
}
