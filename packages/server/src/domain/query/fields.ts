import { AppError } from '../../errors.js';
import type { ActiveField, FieldRecord } from '../tables/types.js';

function invalidQuery(message: string): never {
  throw new AppError('INVALID_QUERY', message);
}

function toQueryField(field: FieldRecord): ActiveField {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    description: field.description,
    activeOptions: new Map(),
    schemaVersion: field.schemaVersion,
  };
}

function byFieldKey(left: Pick<FieldRecord, 'key'>, right: Pick<FieldRecord, 'key'>): number {
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

export function queryableFields(fields: readonly FieldRecord[]): ActiveField[] {
  return fields
    .filter((field) => field.status === 'active' || field.status === 'deprecated')
    .sort(byFieldKey)
    .map(toQueryField);
}

export function selectedDetailFields(
  fields: readonly FieldRecord[],
  includeFields: readonly string[],
): ActiveField[] {
  const fieldsByKey = new Map(fields.map((field) => [field.key, field]));
  const included = new Set<string>();

  for (const fieldKey of includeFields) {
    if (fieldKey.startsWith('_')) {
      invalidQuery(`System field "${fieldKey}" cannot be requested through includeFields`);
    }
    const field = fieldsByKey.get(fieldKey);
    if (field === undefined) {
      invalidQuery(`Unknown field "${fieldKey}" in includeFields`);
    }
    if (field.status === 'active') {
      invalidQuery(`Active field "${fieldKey}" is already selected by default`);
    }
    if (field.status !== 'deprecated') {
      invalidQuery(
        `Field "${fieldKey}" has status "${field.status}" and no selectable physical column`,
      );
    }
    included.add(fieldKey);
  }

  return fields
    .filter(
      (field) =>
        field.status === 'active' || (field.status === 'deprecated' && included.has(field.key)),
    )
    .sort(byFieldKey)
    .map(toQueryField);
}
