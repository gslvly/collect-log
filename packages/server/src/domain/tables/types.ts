export const TABLE_STATUSES = ['creating', 'active', 'disabled', 'archived', 'failed'] as const;

export type TableStatus = (typeof TABLE_STATUSES)[number];

export const FIELD_TYPES = ['string', 'boolean'] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_STATUSES = ['active', 'deprecated', 'dropped', 'renamed'] as const;

export type FieldStatus = (typeof FIELD_STATUSES)[number];

export interface CreateFieldInput {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  description: string;
}

export interface ActiveField extends CreateFieldInput {
  schemaVersion: number;
}

export interface FieldRecord extends CreateFieldInput {
  status: FieldStatus;
  renamedTo: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateFieldInput {
  label?: string | undefined;
  required?: boolean | undefined;
  description?: string | undefined;
}

export interface CreateTableInput {
  displayName: string;
  description: string;
  fields: CreateFieldInput[];
}

export interface TableRecord {
  projectId: string;
  physicalName: string;
  displayName: string;
  description: string;
  status: TableStatus;
  schemaVersion: number;
  ingestSecret: string;
  ingestSecretPrev: string;
  ingestSecretPrevExpiresAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TableDefinition extends TableRecord {
  fields: ActiveField[];
}

export interface TableTemplateSummary {
  projectId: string;
  displayName: string;
  status: TableStatus;
  fieldCount: number;
}

export interface TableTemplate {
  sourceDisplayName: string;
  description: string;
  fields: CreateFieldInput[];
}

export type PublicTable = Omit<
  TableRecord,
  'physicalName' | 'ingestSecret' | 'ingestSecretPrev' | 'ingestSecretPrevExpiresAt'
>;

export function toPublicTable(table: TableRecord): PublicTable {
  return {
    projectId: table.projectId,
    displayName: table.displayName,
    description: table.description,
    status: table.status,
    schemaVersion: table.schemaVersion,
    createdBy: table.createdBy,
    createdAt: table.createdAt,
    updatedAt: table.updatedAt,
  };
}

export function isTableStatus(value: unknown): value is TableStatus {
  return typeof value === 'string' && TABLE_STATUSES.includes(value as TableStatus);
}

export function isFieldType(value: unknown): value is FieldType {
  return typeof value === 'string' && FIELD_TYPES.includes(value as FieldType);
}

export function isFieldStatus(value: unknown): value is FieldStatus {
  return typeof value === 'string' && FIELD_STATUSES.includes(value as FieldStatus);
}
