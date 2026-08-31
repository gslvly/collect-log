import { AppError } from '../../errors.js';
import { assertIdentifier } from '../../infra/clickhouse.js';
import { isSqliteConstraintConflict } from '../../infra/sqlite.js';
import {
  isFieldOptionStatus,
  isFieldStatus,
  isFieldType,
  isTableStatus,
  type ActiveField,
  type CreateFieldInput,
  type FieldOptionInput,
  type FieldRecord,
  type TableRecord,
  type TableTemplateSummary,
} from './types.js';

export interface CollectTableRow {
  project_id: string;
  physical_name: string;
  display_name: string;
  description: string;
  status: string;
  schema_version: number;
  ingest_secret: string;
  ingest_secret_prev: string;
  ingest_secret_prev_expires_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CollectFieldRow {
  project_id: string;
  field_key: string;
  label: string;
  type: string;
  required: number;
  description: string;
  status: string;
  renamed_to: string;
  schema_version: number;
  created_at: string;
  updated_at: string;
}

export interface CollectFieldOptionRow {
  field_key: string;
  value: string;
  label: string;
  status: string;
  sort_order: number;
}

export interface TableTemplateSummaryRow {
  project_id: string;
  display_name: string;
  status: string;
  field_count: number;
}

function parsePositiveInteger(value: number, context: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${context} stored in SQLite`);
  }
  return value;
}

function parseNonNegativeInteger(value: number, context: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${context} stored in SQLite`);
  }
  return value;
}

export function mapTable(row: CollectTableRow): TableRecord {
  if (!isTableStatus(row.status)) {
    throw new Error(`Invalid table status stored in collect_tables: ${row.status}`);
  }

  return {
    projectId: row.project_id,
    physicalName: assertIdentifier(row.physical_name),
    displayName: row.display_name,
    description: row.description,
    status: row.status,
    schemaVersion: parsePositiveInteger(row.schema_version, 'schema version'),
    ingestSecret: row.ingest_secret,
    ingestSecretPrev: row.ingest_secret_prev,
    ingestSecretPrevExpiresAt: row.ingest_secret_prev_expires_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapField(
  row: CollectFieldRow,
  options: FieldOptionInput[] = [],
): FieldRecord {
  if (!isFieldType(row.type)) {
    throw new Error(`Invalid field type stored in collect_fields: ${row.type}`);
  }
  if (!isFieldStatus(row.status)) {
    throw new Error(`Invalid field status stored in collect_fields: ${row.status}`);
  }

  return {
    key: row.field_key,
    label: row.label,
    type: row.type,
    required: row.required === 1,
    description: row.description,
    options,
    status: row.status,
    renamedTo: row.renamed_to,
    schemaVersion: parsePositiveInteger(row.schema_version, 'field schema version'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapFieldOption(row: CollectFieldOptionRow): FieldOptionInput {
  if (!isFieldOptionStatus(row.status)) {
    throw new Error(`Invalid field option status stored in collect_field_options: ${row.status}`);
  }
  return {
    value: row.value,
    label: row.label,
    status: row.status,
  };
}

export function groupFieldOptions(
  rows: readonly CollectFieldOptionRow[],
): Map<string, FieldOptionInput[]> {
  const optionsByField = new Map<string, FieldOptionInput[]>();
  for (const row of rows) {
    const options = optionsByField.get(row.field_key) ?? [];
    options.push(mapFieldOption(row));
    optionsByField.set(row.field_key, options);
  }
  return optionsByField;
}

export function toActiveField(
  field: FieldRecord,
  activeOptions: ReadonlyMap<string, string>,
): ActiveField {
  if (field.status !== 'active') {
    throw new Error(`Expected active field metadata, received status ${field.status}`);
  }
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    description: field.description,
    activeOptions,
    schemaVersion: field.schemaVersion,
  };
}

export function toTemplateField(field: ActiveField): CreateFieldInput {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    description: field.description,
    ...(field.type === 'enum'
      ? {
          options: [...field.activeOptions].map(([value, label]) => ({
            value,
            label,
            status: 'active' as const,
          })),
        }
      : {}),
  };
}

export function mapTableTemplateSummary(
  row: TableTemplateSummaryRow,
): TableTemplateSummary {
  if (!isTableStatus(row.status)) {
    throw new Error(`Invalid table status stored in collect_tables: ${row.status}`);
  }
  return {
    projectId: row.project_id,
    displayName: row.display_name,
    status: row.status,
    fieldCount: parseNonNegativeInteger(row.field_count, 'active field count'),
  };
}

export function translateFieldKeyConflict(
  error: unknown,
  fieldKey: string,
  existing: FieldRecord | null = null,
): never {
  if (isSqliteConstraintConflict(error)) {
    // DESIGN 5.2：`dropped` / `renamed` 的墓碑已在写入前清除，能撞上主键的只剩
    // `active`（正在用）和 `deprecated`（物理列与历史数据都还在，复用会让元数据与列类型脱节）。
    if (existing?.status === 'active') {
      throw new AppError('FIELD_KEY_EXISTS', `Field key "${fieldKey}" already exists`, {
        field: fieldKey,
      });
    }
    throw new AppError(
      'FIELD_KEY_RETIRED',
      `Field key "${fieldKey}" has already been used and cannot be reused`,
      { field: fieldKey },
    );
  }
  throw error;
}
