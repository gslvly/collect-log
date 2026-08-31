import { randomUUID } from 'node:crypto';

import type { Limits } from '../../config/limits.js';
import { AppError, type ExpectedField } from '../../errors.js';
import type { ActiveField, FieldRecord, TableDefinition } from '../tables/types.js';

export interface IngestPayload {
  recordId: string;
  occurredAt: number;
  data: Record<string, unknown>;
}

export type ValidatedFieldValues = Record<string, string | number | boolean | null>;

// DESIGN 8.2 第 6 步只要求「合法 UUID」，不限版本：调用方可能用 v1 / v7 生成稳定的 recordId，
// 物理列是 ClickHouse 的 UUID 类型，同样不区分版本。
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesFieldType(value: unknown, fieldType: ActiveField['type']): boolean {
  if (fieldType === 'string' || fieldType === 'enum') {
    return typeof value === 'string';
  }
  if (fieldType === 'boolean') {
    return typeof value === 'boolean';
  }
  return typeof value === 'number';
}

function expectedField(
  field: Pick<ActiveField | FieldRecord, 'key' | 'label' | 'type' | 'required'> & {
    activeOptions?: ReadonlyMap<string, string>;
  },
  maxEnumOptions: number,
): ExpectedField {
  const expected: ExpectedField = {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
  };
  if (field.type === 'enum') {
    const activeOptions = field.activeOptions ?? new Map<string, string>();
    expected.options = [...activeOptions.keys()].slice(0, maxEnumOptions);
  }
  return expected;
}

interface SubmittedFieldValue {
  field: ActiveField;
  value: unknown;
}

function validateFieldTypes(
  submitted: readonly SubmittedFieldValue[],
  schemaVersion: number,
  schemaLimits: Limits['schema'],
): void {
  for (const { field, value } of submitted) {
    if (!matchesFieldType(value, field.type)) {
      const message = `Field "${field.key}" expects ${field.type}, got ${String(value)}`;
      throw new AppError('INVALID_FIELD_TYPE', message, {
        field: field.key,
        expected: expectedField(field, schemaLimits.maxEnumOptions),
        schemaVersion,
      });
    }
  }
}

function invalidFieldValue(
  field: ActiveField,
  message: string,
  schemaVersion: number,
  schemaLimits: Limits['schema'],
): never {
  throw new AppError('INVALID_FIELD_VALUE', message, {
    field: field.key,
    expected: expectedField(field, schemaLimits.maxEnumOptions),
    schemaVersion,
  });
}

function validateFieldValueDomains(
  submitted: readonly SubmittedFieldValue[],
  schemaVersion: number,
  ingestLimits: Limits['ingest'],
  schemaLimits: Limits['schema'],
): void {
  for (const { field, value } of submitted) {
    if (field.type === 'string') {
      const stringValue = value as string;
      if (Buffer.byteLength(stringValue, 'utf8') > ingestLimits.maxStringLength) {
        throw new AppError(
          'FIELD_VALUE_TOO_LONG',
          `Field "${field.key}" exceeds ${ingestLimits.maxStringLength} UTF-8 bytes`,
          {
            field: field.key,
            expected: expectedField(field, schemaLimits.maxEnumOptions),
            schemaVersion,
          },
        );
      }
      continue;
    }

    if (field.type === 'enum') {
      const stringValue = value as string;
      if (!field.activeOptions.has(stringValue)) {
        const remaining = Math.max(0, field.activeOptions.size - schemaLimits.maxEnumOptions);
        const truncated = remaining === 0 ? '' : `; expected.options omits ${remaining} more`;
        invalidFieldValue(
          field,
          `Field "${field.key}" expects one of the registered active options, got ${JSON.stringify(stringValue)}${truncated}`,
          schemaVersion,
          schemaLimits,
        );
      }
      continue;
    }

    if (field.type === 'integer') {
      const numberValue = value as number;
      if (!Number.isInteger(numberValue) || Math.abs(numberValue) > Number.MAX_SAFE_INTEGER) {
        invalidFieldValue(
          field,
          `Field "${field.key}" must be an integer between ${Number.MIN_SAFE_INTEGER} and ${Number.MAX_SAFE_INTEGER}`,
          schemaVersion,
          schemaLimits,
        );
      }
      continue;
    }

    if (field.type === 'float') {
      if (!Number.isFinite(value as number)) {
        invalidFieldValue(
          field,
          `Field "${field.key}" must be a finite number`,
          schemaVersion,
          schemaLimits,
        );
      }
      continue;
    }

    if (field.type === 'datetime') {
      const numberValue = value as number;
      if (
        !Number.isInteger(numberValue) ||
        numberValue < ingestLimits.datetimeMinMs ||
        numberValue > ingestLimits.datetimeMaxMs
      ) {
        invalidFieldValue(
          field,
          `Field "${field.key}" must be an integer millisecond timestamp between ${ingestLimits.datetimeMinMs} and ${ingestLimits.datetimeMaxMs}`,
          schemaVersion,
          schemaLimits,
        );
      }
    }
  }
}

export function parsePayload(
  rawPayload: string,
  now: number,
  ingestLimits: Limits['ingest'],
  generateRecordId: () => string = randomUUID,
): IngestPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    throw new AppError('INVALID_JSON', 'Payload d is not valid JSON');
  }

  if (!isPlainObject(parsed) || !isPlainObject(parsed.data)) {
    throw new AppError('INVALID_ENVELOPE', 'Payload and payload data must be objects');
  }

  const recordId = parsed.recordId === undefined ? generateRecordId() : parsed.recordId;
  if (typeof recordId !== 'string' || !UUID_PATTERN.test(recordId)) {
    throw new AppError('INVALID_RECORD_ID', 'recordId must be a valid UUID');
  }

  const { occurredAt } = parsed;
  if (
    typeof occurredAt !== 'number' ||
    !Number.isFinite(occurredAt) ||
    occurredAt < now - ingestLimits.occurredAtPastMs ||
    occurredAt > now + ingestLimits.occurredAtFutureMs
  ) {
    throw new AppError('INVALID_OCCURRED_AT', 'occurredAt is outside the allowed time window');
  }

  if (Object.keys(parsed.data).length > ingestLimits.maxFields) {
    throw new AppError(
      'TOO_MANY_FIELDS',
      `Payload data may contain at most ${ingestLimits.maxFields} fields`,
    );
  }

  return { recordId, occurredAt, data: parsed.data };
}

function unknownFieldMessage(
  fieldKey: string,
  fields: readonly ActiveField[],
  maxFields: number,
): string {
  const allowed = fields.slice(0, maxFields).map((field) => field.key);
  const remaining = Math.max(0, fields.length - allowed.length);
  const allowedText = allowed.length === 0 ? '(none)' : allowed.join(', ');
  const truncatedText = remaining === 0 ? '' : `; and ${remaining} more`;
  return `Unknown field "${fieldKey}". Allowed fields: ${allowedText}${truncatedText}`;
}

export async function validateFieldValues(
  data: Record<string, unknown>,
  definition: Pick<TableDefinition, 'projectId' | 'schemaVersion' | 'fields'>,
  listFields: (projectId: string) => Promise<FieldRecord[]>,
  ingestLimits: Limits['ingest'],
  schemaLimits: Limits['schema'],
): Promise<ValidatedFieldValues> {
  const activeByKey = new Map(definition.fields.map((field) => [field.key, field]));
  const unknownKeys = Object.keys(data).filter(
    (key) => data[key] !== null && data[key] !== undefined && !activeByKey.has(key),
  );

  if (unknownKeys.length > 0) {
    const fieldKey = unknownKeys[0];
    if (fieldKey === undefined) {
      throw new Error('Unknown field validation lost its first key');
    }
    const retired = (await listFields(definition.projectId)).find(
      (field) => field.key === fieldKey,
    );
    if (retired?.status === 'deprecated') {
      throw new AppError('DEPRECATED_FIELD', `Field "${fieldKey}" is deprecated`, {
        field: fieldKey,
        expected: expectedField(retired, schemaLimits.maxEnumOptions),
        schemaVersion: definition.schemaVersion,
      });
    }
    throw new AppError(
      'UNKNOWN_FIELD',
      unknownFieldMessage(fieldKey, definition.fields, ingestLimits.maxFields),
      { field: fieldKey, schemaVersion: definition.schemaVersion },
    );
  }

  const values: ValidatedFieldValues = {};
  const submitted: SubmittedFieldValue[] = [];
  for (const field of definition.fields) {
    const value = Object.hasOwn(data, field.key) ? data[field.key] : undefined;
    if (value === null || value === undefined) {
      if (field.required) {
        throw new AppError('REQUIRED_FIELD_MISSING', `Required field "${field.key}" is missing`, {
          field: field.key,
          expected: expectedField(field, schemaLimits.maxEnumOptions),
          schemaVersion: definition.schemaVersion,
        });
      }
      values[field.key] = null;
      continue;
    }
    submitted.push({ field, value });
  }

  validateFieldTypes(submitted, definition.schemaVersion, schemaLimits);
  validateFieldValueDomains(submitted, definition.schemaVersion, ingestLimits, schemaLimits);

  for (const { field, value } of submitted) {
    values[field.key] = value as string | number | boolean;
  }
  return values;
}
