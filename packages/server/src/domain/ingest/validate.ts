import { randomUUID } from 'node:crypto';

import type { Limits } from '../../config/limits.js';
import { AppError, type ExpectedField } from '../../errors.js';
import type { ActiveField, FieldRecord, TableDefinition } from '../tables/types.js';

export interface IngestPayload {
  recordId: string;
  occurredAt: number;
  data: Record<string, unknown>;
}

export type ValidatedFieldValues = Record<string, string | boolean | null>;

// DESIGN 8.2 第 6 步只要求「合法 UUID」，不限版本：调用方可能用 v1 / v7 生成稳定的 recordId，
// 物理列是 ClickHouse 的 UUID 类型，同样不区分版本。
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectedField(
  field: Pick<ActiveField | FieldRecord, 'key' | 'label' | 'type' | 'required'>,
): ExpectedField {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
  };
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
        expected: expectedField(retired),
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
  for (const field of definition.fields) {
    const value = Object.hasOwn(data, field.key) ? data[field.key] : undefined;
    if (value === null || value === undefined) {
      if (field.required) {
        throw new AppError('REQUIRED_FIELD_MISSING', `Required field "${field.key}" is missing`, {
          field: field.key,
          expected: expectedField(field),
          schemaVersion: definition.schemaVersion,
        });
      }
      values[field.key] = null;
      continue;
    }

    if (typeof value !== field.type) {
      throw new AppError(
        'INVALID_FIELD_TYPE',
        `Field "${field.key}" expects ${field.type}, got ${typeof value}`,
        {
          field: field.key,
          expected: expectedField(field),
          schemaVersion: definition.schemaVersion,
        },
      );
    }
    if (
      field.type === 'string' &&
      typeof value === 'string' &&
      Buffer.byteLength(value, 'utf8') > ingestLimits.maxStringLength
    ) {
      throw new AppError(
        'FIELD_VALUE_TOO_LONG',
        `Field "${field.key}" exceeds ${ingestLimits.maxStringLength} UTF-8 bytes`,
        {
          field: field.key,
          expected: expectedField(field),
          schemaVersion: definition.schemaVersion,
        },
      );
    }

    values[field.key] = value as string | boolean;
  }
  return values;
}
