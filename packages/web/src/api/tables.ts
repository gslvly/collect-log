import { requestJson } from './client.js';

export const TABLE_STATUSES = ['creating', 'active', 'disabled', 'archived', 'failed'] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];

export const FIELD_TYPES = ['string', 'boolean'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

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
}

export interface CreateTableInput {
  displayName: string;
  description: string;
  fields: CreateFieldInput[];
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
