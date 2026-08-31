import { requestJson } from './client.js';

export const TABLE_STATUSES = ['creating', 'active', 'disabled', 'archived', 'failed'] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];

export const FIELD_TYPES = ['string', 'enum', 'boolean', 'integer', 'float', 'datetime'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_OPTION_STATUSES = ['active', 'disabled'] as const;
export type FieldOptionStatus = (typeof FIELD_OPTION_STATUSES)[number];

export const FIELD_STATUSES = ['active', 'deprecated', 'dropped', 'renamed'] as const;
export type FieldStatus = (typeof FIELD_STATUSES)[number];

export interface CollectionTable {
  projectId: string;
  displayName: string;
  description: string;
  status: TableStatus;
  schemaVersion: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFieldInput {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  description: string;
  options?: FieldOptionInput[];
}

export interface FieldOptionInput {
  value: string;
  label: string;
  status: FieldOptionStatus;
}

export interface CreateTableInput {
  displayName: string;
  description: string;
  fields: CreateFieldInput[];
}

export interface CollectionField extends Omit<CreateFieldInput, 'options'> {
  options: FieldOptionInput[];
  status: FieldStatus;
  renamedTo: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateFieldInput {
  label?: string;
  required?: boolean;
  description?: string;
}

export interface RetypeFieldInput {
  type: FieldType;
  options?: FieldOptionInput[];
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

interface TablesResponse {
  tables: CollectionTable[];
}

interface CreateTableResponse {
  projectId: string;
  ingestSecret: string;
}

export interface TableDetailResponse {
  table: CollectionTable;
  fields: CollectionField[];
}

interface TableChangeResponse {
  table: CollectionTable;
}

interface FieldChangeResponse extends TableChangeResponse {
  field: CollectionField;
}

interface RenameFieldResponse extends FieldChangeResponse {
  message: string;
}

interface RetypeFieldResponse extends FieldChangeResponse {
  message: string;
}

interface SecretResponse {
  projectId: string;
  ingestSecret: string;
}

interface CountResponse {
  count: number;
}

interface DeleteTableResponse {
  projectId: string;
  deleted: true;
}

interface TableTemplatesResponse {
  templates: TableTemplateSummary[];
}

export function listTables(): Promise<TablesResponse> {
  return requestJson<TablesResponse>('/api/admin/tables');
}

export function createTable(input: CreateTableInput): Promise<CreateTableResponse> {
  return requestJson<CreateTableResponse>('/api/admin/tables', {
    method: 'POST',
    body: input,
  });
}

export function listTableTemplates(): Promise<TableTemplatesResponse> {
  return requestJson<TableTemplatesResponse>('/api/admin/tables/templates');
}

export function getTableTemplate(projectId: string): Promise<TableTemplate> {
  return requestJson<TableTemplate>(`/api/admin/tables/${encodeURIComponent(projectId)}/template`);
}

function tablePath(projectId: string): string {
  return `/api/admin/tables/${encodeURIComponent(projectId)}`;
}

function fieldPath(projectId: string, fieldKey: string): string {
  return `${tablePath(projectId)}/fields/${encodeURIComponent(fieldKey)}`;
}

export function getTableDetail(projectId: string): Promise<TableDetailResponse> {
  return requestJson<TableDetailResponse>(tablePath(projectId));
}

export function retryTable(projectId: string): Promise<TableChangeResponse> {
  return requestJson<TableChangeResponse>(`${tablePath(projectId)}/retry`, { method: 'POST' });
}

export function setTableStatus(
  projectId: string,
  status: TableStatus,
): Promise<TableChangeResponse> {
  return requestJson<TableChangeResponse>(`${tablePath(projectId)}/status`, {
    method: 'POST',
    body: { status },
  });
}

export function deleteTable(projectId: string, confirm: string): Promise<DeleteTableResponse> {
  return requestJson<DeleteTableResponse>(tablePath(projectId), {
    method: 'DELETE',
    body: { confirm },
  });
}

export function getTableSecret(projectId: string): Promise<SecretResponse> {
  return requestJson<SecretResponse>(`${tablePath(projectId)}/secret`);
}

export function rotateTableSecret(projectId: string): Promise<SecretResponse> {
  return requestJson<SecretResponse>(`${tablePath(projectId)}/secret/rotate`, { method: 'POST' });
}

export function addTableField(
  projectId: string,
  input: CreateFieldInput,
): Promise<FieldChangeResponse> {
  return requestJson<FieldChangeResponse>(`${tablePath(projectId)}/fields`, {
    method: 'POST',
    body: input,
  });
}

export function updateTableField(
  projectId: string,
  fieldKey: string,
  input: UpdateFieldInput,
): Promise<FieldChangeResponse> {
  return requestJson<FieldChangeResponse>(fieldPath(projectId, fieldKey), {
    method: 'PATCH',
    body: input,
  });
}

export function renameTableField(
  projectId: string,
  fieldKey: string,
  key: string,
): Promise<RenameFieldResponse> {
  return requestJson<RenameFieldResponse>(`${fieldPath(projectId, fieldKey)}/rename`, {
    method: 'POST',
    body: { key },
  });
}

export function updateTableFieldOptions(
  projectId: string,
  fieldKey: string,
  options: FieldOptionInput[],
): Promise<FieldChangeResponse> {
  return requestJson<FieldChangeResponse>(`${fieldPath(projectId, fieldKey)}/options`, {
    method: 'PUT',
    body: { options },
  });
}

export function retypeTableField(
  projectId: string,
  fieldKey: string,
  input: RetypeFieldInput,
): Promise<RetypeFieldResponse> {
  return requestJson<RetypeFieldResponse>(`${fieldPath(projectId, fieldKey)}/retype`, {
    method: 'POST',
    body: input,
  });
}

export function deprecateTableField(
  projectId: string,
  fieldKey: string,
): Promise<FieldChangeResponse> {
  return requestJson<FieldChangeResponse>(`${fieldPath(projectId, fieldKey)}/deprecate`, {
    method: 'POST',
  });
}

export function deleteTableField(
  projectId: string,
  fieldKey: string,
  confirm: string,
): Promise<FieldChangeResponse> {
  return requestJson<FieldChangeResponse>(fieldPath(projectId, fieldKey), {
    method: 'DELETE',
    body: { confirm },
  });
}

export function getTableFieldUsage(projectId: string, fieldKey: string): Promise<CountResponse> {
  return requestJson<CountResponse>(`${fieldPath(projectId, fieldKey)}/usage`);
}

export function getTableRowCount(projectId: string): Promise<CountResponse> {
  return requestJson<CountResponse>(`${tablePath(projectId)}/row-count`);
}
