import type { PreparedStatement, SqliteDatabase } from '../../infra/sqlite.js';
import type {
  CollectFieldOptionRow,
  CollectFieldRow,
  CollectTableRow,
  TableTemplateSummaryRow,
} from './repository.rows.js';

export interface TableStatements {
  list: PreparedStatement<CollectTableRow>;
  listTemplates: PreparedStatement<TableTemplateSummaryRow>;
  findById: PreparedStatement<CollectTableRow>;
  listFields: PreparedStatement<CollectFieldRow>;
  listActiveFields: PreparedStatement<CollectFieldRow>;
  listFieldOptions: PreparedStatement<CollectFieldOptionRow>;
  listAllFieldOptions: PreparedStatement<CollectFieldOptionRow>;
  listActiveFieldOptions: PreparedStatement<CollectFieldOptionRow>;
  findField: PreparedStatement<CollectFieldRow>;
  deleteRetiredField: PreparedStatement;
  insertTable: PreparedStatement;
  updateTable: PreparedStatement;
  insertField: PreparedStatement;
  insertFieldOption: PreparedStatement;
  updateFieldOption: PreparedStatement;
  deleteFieldOptions: PreparedStatement;
  renameFieldOptions: PreparedStatement;
  updateField: PreparedStatement;
  deleteFieldsByProjectId: PreparedStatement;
  deleteTableByProjectId: PreparedStatement;
}

export function prepareTableStatements(database: SqliteDatabase): TableStatements {
  return {
    list: database.prepare<CollectTableRow>(`SELECT *
FROM collect_tables
ORDER BY created_at DESC, project_id`),
    listTemplates: database.prepare<TableTemplateSummaryRow>(`SELECT
  tables.project_id,
  tables.display_name,
  tables.status,
  count(fields.field_key) AS field_count
FROM collect_tables AS tables
LEFT JOIN collect_fields AS fields
  ON fields.project_id = tables.project_id AND fields.status = 'active'
GROUP BY tables.project_id, tables.display_name, tables.status, tables.created_at
ORDER BY tables.created_at DESC, tables.project_id`),
    findById: database.prepare<CollectTableRow>(`SELECT *
FROM collect_tables
WHERE project_id = ?`),
    listFields: database.prepare<CollectFieldRow>(`SELECT *
FROM collect_fields
WHERE project_id = ?
ORDER BY field_key`),
    listActiveFields: database.prepare<CollectFieldRow>(`SELECT *
FROM collect_fields
WHERE project_id = ? AND status = 'active'
ORDER BY field_key`),
    listFieldOptions: database.prepare<CollectFieldOptionRow>(`SELECT
  field_key,
  value,
  label,
  status,
  sort_order
FROM collect_field_options
WHERE project_id = ? AND field_key = ?
ORDER BY sort_order, value`),
    listAllFieldOptions: database.prepare<CollectFieldOptionRow>(`SELECT
  field_key,
  value,
  label,
  status,
  sort_order
FROM collect_field_options
WHERE project_id = ?
ORDER BY field_key, sort_order, value`),
    listActiveFieldOptions: database.prepare<CollectFieldOptionRow>(`SELECT
  field_key,
  value,
  label,
  status,
  sort_order
FROM collect_field_options
WHERE project_id = ? AND status = 'active'
ORDER BY field_key, sort_order, value`),
    findField: database.prepare<CollectFieldRow>(`SELECT *
FROM collect_fields
WHERE project_id = ? AND field_key = ?`),
    deleteRetiredField: database.prepare(`DELETE FROM collect_fields
WHERE project_id = ? AND field_key = ? AND status IN ('dropped', 'renamed')`),
    insertTable: database.prepare(`INSERT INTO collect_tables
  (project_id, physical_name, display_name, description, status, schema_version,
   ingest_secret, ingest_secret_prev, ingest_secret_prev_expires_at, created_by, created_at,
   updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateTable: database.prepare(`UPDATE collect_tables
SET status = ?, schema_version = ?, ingest_secret = ?, ingest_secret_prev = ?,
    ingest_secret_prev_expires_at = ?, updated_at = ?
WHERE project_id = ?`),
    insertField: database.prepare(`INSERT INTO collect_fields
  (project_id, field_key, label, type, required, description, status, renamed_to, schema_version,
   created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertFieldOption: database.prepare(`INSERT INTO collect_field_options
  (project_id, field_key, value, label, status, sort_order, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    updateFieldOption: database.prepare(`UPDATE collect_field_options
SET label = ?, status = ?, sort_order = ?, updated_at = ?
WHERE project_id = ? AND field_key = ? AND value = ?`),
    deleteFieldOptions: database.prepare(`DELETE FROM collect_field_options
WHERE project_id = ? AND field_key = ?`),
    renameFieldOptions: database.prepare(`UPDATE collect_field_options
SET field_key = ?, updated_at = ?
WHERE project_id = ? AND field_key = ?`),
    updateField: database.prepare(`UPDATE collect_fields
SET label = ?, type = ?, required = ?, description = ?, status = ?, renamed_to = ?,
    schema_version = ?, updated_at = ?
WHERE project_id = ? AND field_key = ?`),
    deleteFieldsByProjectId: database.prepare(`DELETE FROM collect_fields
WHERE project_id = ?`),
    deleteTableByProjectId: database.prepare(`DELETE FROM collect_tables
WHERE project_id = ?`),
  };
}
