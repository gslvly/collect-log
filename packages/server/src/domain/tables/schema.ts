import type { Limits } from '../../config/limits.js';
import { AppError } from '../../errors.js';
import { assertIdentifier } from '../../infra/clickhouse.js';
import type { CreateFieldInput, FieldType } from './types.js';

export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const PHYSICAL_TYPES: Readonly<Record<FieldType, string>> = {
  string: 'Nullable(String)',
  enum: 'LowCardinality(Nullable(String))',
  boolean: 'Nullable(Bool)',
  integer: 'Nullable(Int64)',
  float: 'Nullable(Float64)',
  datetime: "Nullable(DateTime64(3, 'UTC'))",
};

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

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

export function validateFieldOptions(
  field: CreateFieldInput,
  schemaLimits: Limits['schema'],
): void {
  if (field.type !== 'enum') {
    if (field.options !== undefined) {
      throw new AppError(
        'INVALID_FIELD_VALUE',
        `Field "${field.key}" of type "${field.type}" must not define options`,
        { field: field.key },
      );
    }
    return;
  }

  const options = field.options;
  if (options !== undefined && options.length > schemaLimits.maxEnumOptions) {
    throw new AppError(
      'INVALID_FIELD_VALUE',
      `Enum field "${field.key}" may define at most ${schemaLimits.maxEnumOptions} options`,
      { field: field.key },
    );
  }
  if (options === undefined || !options.some((option) => option.status === 'active')) {
    throw new AppError(
      'INVALID_FIELD_VALUE',
      `Enum field "${field.key}" must define at least one active option`,
      { field: field.key },
    );
  }

  const values = new Set<string>();
  for (const option of options) {
    if (
      option.value.length === 0 ||
      Buffer.byteLength(option.value, 'utf8') > schemaLimits.maxOptionValueBytes ||
      containsControlCharacter(option.value)
    ) {
      throw new AppError(
        'INVALID_FIELD_VALUE',
        `Enum option value for field "${field.key}" must contain 1-${schemaLimits.maxOptionValueBytes} UTF-8 bytes and no control characters`,
        { field: field.key },
      );
    }
    const labelBytes = Buffer.byteLength(option.label, 'utf8');
    if (labelBytes === 0 || labelBytes > schemaLimits.maxOptionLabelBytes) {
      throw new AppError(
        'INVALID_FIELD_VALUE',
        `Enum option label for field "${field.key}" must contain 1-${schemaLimits.maxOptionLabelBytes} UTF-8 bytes`,
        { field: field.key },
      );
    }
    if (values.has(option.value)) {
      throw new AppError(
        'INVALID_FIELD_VALUE',
        `Enum option value "${option.value}" is duplicated for field "${field.key}"`,
        { field: field.key },
      );
    }
    values.add(option.value);
  }
}

export function validateInitialFields(
  fields: readonly CreateFieldInput[],
  schemaLimits: Limits['schema'],
): void {
  if (fields.length > schemaLimits.maxFieldsPerTable) {
    throw new AppError(
      'TOO_MANY_FIELDS',
      `A table may define at most ${schemaLimits.maxFieldsPerTable} fields`,
    );
  }

  const seen = new Set<string>();
  for (const field of fields) {
    assertValidFieldKey(field.key);
    physicalTypeFor(field.type);
    validateFieldOptions(field, schemaLimits);
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
