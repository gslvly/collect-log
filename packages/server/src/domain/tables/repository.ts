import { randomBytes } from 'node:crypto';

import { ulid } from 'ulid';

import { configuredLimits } from '../../config/limits.js';
import { AppError } from '../../errors.js';
import {
  assertIdentifier,
  metaClient,
  parameterizedQuery,
  readonlyClient,
} from '../../infra/clickhouse.js';
import { serial } from '../../infra/serial.js';
import {
  isSqliteConstraintConflict,
  sqliteDatabase,
  type PreparedStatement,
  type SqliteDatabase,
} from '../../infra/sqlite.js';
import { TableMetadataCache, tableMetadataCache } from './cache.js';
import {
  assertValidFieldKey,
  buildPhysicalTableDdl,
  physicalTypeFor,
  validateInitialFields,
} from './schema.js';
import { assertTableStatusTransition } from './state-machine.js';
import {
  isFieldType,
  isFieldStatus,
  isTableStatus,
  type ActiveField,
  type CreateFieldInput,
  type CreateTableInput,
  type FieldRecord,
  type TableDefinition,
  type TableRecord,
  type TableStatus,
  type TableTemplate,
  type TableTemplateSummary,
  type UpdateFieldInput,
} from './types.js';

interface CollectTableRow {
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

interface CollectFieldRow {
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

interface TableTemplateSummaryRow {
  project_id: string;
  display_name: string;
  status: string;
  field_count: number;
}

interface TableStatements {
  list: PreparedStatement<CollectTableRow>;
  listTemplates: PreparedStatement<TableTemplateSummaryRow>;
  findById: PreparedStatement<CollectTableRow>;
  listFields: PreparedStatement<CollectFieldRow>;
  listActiveFields: PreparedStatement<CollectFieldRow>;
  findField: PreparedStatement<CollectFieldRow>;
  deleteRetiredField: PreparedStatement;
  insertTable: PreparedStatement;
  updateTable: PreparedStatement;
  insertField: PreparedStatement;
  updateField: PreparedStatement;
  deleteFieldsByProjectId: PreparedStatement;
  deleteTableByProjectId: PreparedStatement;
}

export interface CreateTableResult {
  table: TableRecord;
  ingestSecret: string;
}

export interface FieldChangeResult {
  table: TableRecord;
  field: FieldRecord;
}

const PREVIOUS_SECRET_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1_000;

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

function mapTable(row: CollectTableRow): TableRecord {
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

function mapField(row: CollectFieldRow): FieldRecord {
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
    status: row.status,
    renamedTo: row.renamed_to,
    schemaVersion: parsePositiveInteger(row.schema_version, 'field schema version'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toActiveField(field: FieldRecord): ActiveField {
  if (field.status !== 'active') {
    throw new Error(`Expected active field metadata, received status ${field.status}`);
  }
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    description: field.description,
    schemaVersion: field.schemaVersion,
  };
}

function toTemplateField(field: ActiveField): CreateFieldInput {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    description: field.description,
  };
}

function mapTableTemplateSummary(row: TableTemplateSummaryRow): TableTemplateSummary {
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

export class TableRepository {
  private preparedStatements: TableStatements | undefined;

  constructor(
    private readonly database: SqliteDatabase = sqliteDatabase,
    private readonly cache: TableMetadataCache = tableMetadataCache,
  ) {}

  async list(): Promise<TableRecord[]> {
    return this.statements().list.all().map(mapTable);
  }

  async listTemplates(): Promise<TableTemplateSummary[]> {
    return this.statements().listTemplates.all().map(mapTableTemplateSummary);
  }

  async findById(projectId: string): Promise<TableRecord | null> {
    return this.findByIdSync(projectId);
  }

  async listActiveFields(projectId: string): Promise<ActiveField[]> {
    return this.listActiveFieldsSync(projectId);
  }

  async listFields(projectId: string): Promise<FieldRecord[]> {
    return this.statements().listFields.all(projectId).map(mapField);
  }

  getDefinition(projectId: string): Promise<TableDefinition | null> {
    return this.cache.get(projectId, async () => {
      const [table, fields] = await Promise.all([
        this.findById(projectId),
        this.listActiveFields(projectId),
      ]);
      return table === null ? null : { ...table, fields };
    });
  }

  async getTemplate(projectId: string): Promise<TableTemplate | null> {
    const table = this.findByIdSync(projectId);
    if (table === null) {
      return null;
    }
    return {
      sourceDisplayName: table.displayName,
      description: table.description,
      fields: this.listActiveFieldsSync(projectId).map(toTemplateField),
    };
  }

  addField(projectId: string, input: CreateFieldInput): Promise<FieldChangeResult> {
    const fieldKey = assertValidFieldKey(input.key);
    const physicalType = physicalTypeFor(input.type);

    return serial(async () => {
      const table = this.database.transaction(() =>
        this.requireFieldChangeableTableSync(projectId),
      );
      await this.addPhysicalColumn(table.physicalName, fieldKey, physicalType);

      try {
        const changed = this.database.transaction(() => {
          const current = this.requireFieldChangeableTableSync(projectId);
          const schemaVersion = current.schemaVersion + 1;
          const now = new Date().toISOString();
          const field: FieldRecord = {
            ...input,
            key: fieldKey,
            status: 'active',
            renamedTo: '',
            schemaVersion,
            createdAt: now,
            updatedAt: now,
          };
          this.retireTombstoneSync(projectId, fieldKey);
          this.insertFieldRow(projectId, field);
          return {
            table: this.updateTableRow(current, { schemaVersion }),
            field,
          };
        });
        this.cache.invalidate(projectId);
        return changed;
      } catch (error) {
        return translateFieldKeyConflict(error, fieldKey, this.findFieldTx(projectId, fieldKey));
      }
    });
  }

  updateField(
    projectId: string,
    fieldKey: string,
    input: UpdateFieldInput,
  ): Promise<FieldChangeResult> {
    const safeFieldKey = assertValidFieldKey(fieldKey);

    return serial(async () => {
      const changed = this.database.transaction(() => {
        const table = this.requireFieldChangeableTableSync(projectId);
        const current = this.requireActiveFieldSync(projectId, safeFieldKey);
        const requiredChanged = input.required !== undefined && input.required !== current.required;
        const schemaVersion = table.schemaVersion + (requiredChanged ? 1 : 0);
        const field: FieldRecord = {
          ...current,
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.required === undefined ? {} : { required: input.required }),
          ...(input.description === undefined ? {} : { description: input.description }),
          schemaVersion: requiredChanged ? schemaVersion : current.schemaVersion,
          updatedAt: new Date().toISOString(),
        };
        this.updateFieldRow(projectId, field);
        return {
          table: this.updateTableRow(table, { schemaVersion }),
          field,
        };
      });
      this.cache.invalidate(projectId);
      return changed;
    });
  }

  renameField(
    projectId: string,
    fieldKey: string,
    newFieldKey: string,
  ): Promise<FieldChangeResult> {
    const safeFieldKey = assertValidFieldKey(fieldKey);
    const safeNewFieldKey = assertValidFieldKey(newFieldKey);

    return serial(async () => {
      const context = this.database.transaction(() => ({
        table: this.requireFieldChangeableTableSync(projectId),
        field: this.requireActiveFieldSync(projectId, safeFieldKey),
      }));

      try {
        await this.renamePhysicalColumn(context.table.physicalName, safeFieldKey, safeNewFieldKey);
      } catch (error) {
        this.translateRenameDdlConflict(projectId, context.field, safeNewFieldKey, error);
      }

      try {
        const changed = this.database.transaction(() => {
          const table = this.requireFieldChangeableTableSync(projectId);
          const current = this.requireActiveFieldSync(projectId, safeFieldKey);
          const schemaVersion = table.schemaVersion + 1;
          const now = new Date().toISOString();
          const retired: FieldRecord = {
            ...current,
            status: 'renamed',
            renamedTo: safeNewFieldKey,
            schemaVersion,
            updatedAt: now,
          };
          const field: FieldRecord = {
            ...current,
            key: safeNewFieldKey,
            status: 'active',
            renamedTo: '',
            schemaVersion,
            createdAt: now,
            updatedAt: now,
          };
          this.updateFieldRow(projectId, retired);
          this.retireTombstoneSync(projectId, safeNewFieldKey);
          this.insertFieldRow(projectId, field);
          return {
            table: this.updateTableRow(table, { schemaVersion }),
            field,
          };
        });
        this.cache.invalidate(projectId);
        return changed;
      } catch (error) {
        if (isSqliteConstraintConflict(error)) {
          await this.renamePhysicalColumn(
            context.table.physicalName,
            safeNewFieldKey,
            safeFieldKey,
          );
        }
        return translateFieldKeyConflict(
          error,
          safeNewFieldKey,
          this.findFieldTx(projectId, safeNewFieldKey),
        );
      }
    });
  }

  deprecateField(projectId: string, fieldKey: string): Promise<FieldChangeResult> {
    const safeFieldKey = assertValidFieldKey(fieldKey);

    return serial(async () => {
      const changed = this.database.transaction(() => {
        const table = this.requireFieldChangeableTableSync(projectId);
        const current = this.requireActiveFieldSync(projectId, safeFieldKey);
        const schemaVersion = table.schemaVersion + 1;
        const field: FieldRecord = {
          ...current,
          status: 'deprecated',
          schemaVersion,
          updatedAt: new Date().toISOString(),
        };
        this.updateFieldRow(projectId, field);
        return {
          table: this.updateTableRow(table, { schemaVersion }),
          field,
        };
      });
      this.cache.invalidate(projectId);
      return changed;
    });
  }

  dropField(projectId: string, fieldKey: string, confirm: unknown): Promise<FieldChangeResult> {
    const safeFieldKey = assertValidFieldKey(fieldKey);
    this.assertConfirmed(safeFieldKey, confirm);

    return serial(async () => {
      const context = this.database.transaction(() => ({
        table: this.requireFieldChangeableTableSync(projectId),
        field: this.requireActiveFieldSync(projectId, safeFieldKey),
      }));
      await this.dropPhysicalColumn(context.table.physicalName, safeFieldKey);

      const changed = this.database.transaction(() => {
        const table = this.requireFieldChangeableTableSync(projectId);
        const current = this.requireActiveFieldSync(projectId, safeFieldKey);
        const schemaVersion = table.schemaVersion + 1;
        const field: FieldRecord = {
          ...current,
          status: 'dropped',
          schemaVersion,
          updatedAt: new Date().toISOString(),
        };
        this.updateFieldRow(projectId, field);
        return {
          table: this.updateTableRow(table, { schemaVersion }),
          field,
        };
      });
      this.cache.invalidate(projectId);
      return changed;
    });
  }

  fieldUsage(projectId: string, fieldKey: string): Promise<number> {
    const safeFieldKey = assertValidFieldKey(fieldKey);
    return serial(async () => {
      const table = this.database.transaction(() => {
        const current = this.requireFieldChangeableTableSync(projectId);
        this.requirePhysicalFieldSync(projectId, safeFieldKey);
        return current;
      });
      const rows = await parameterizedQuery<{ count: string }>({
        client: readonlyClient,
        query: `SELECT count() AS count
FROM data.${assertIdentifier(table.physicalName)}
WHERE \`${safeFieldKey}\` IS NOT NULL`,
        params: {},
      });
      const count = Number(rows[0]?.count ?? Number.NaN);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(
          `Invalid field usage count returned by ClickHouse: ${String(rows[0]?.count)}`,
        );
      }
      return count;
    });
  }

  create(input: CreateTableInput, operator: string): Promise<CreateTableResult> {
    validateInitialFields(input.fields, configuredLimits.schema.maxFieldsPerTable);
    const projectId = `prj_${ulid()}`;
    const physicalName = assertIdentifier(`collect_${randomBytes(16).toString('hex')}`);
    const ingestSecret = randomBytes(32).toString('base64url');

    return serial(async () => {
      const now = new Date().toISOString();
      const creating: TableRecord = {
        projectId,
        physicalName,
        displayName: input.displayName,
        description: input.description,
        status: 'creating',
        schemaVersion: 1,
        ingestSecret,
        ingestSecretPrev: '',
        ingestSecretPrevExpiresAt: null,
        createdBy: operator,
        createdAt: now,
        updatedAt: now,
      };

      try {
        this.database.transaction(() => {
          this.insertTable(creating);
          this.insertInitialFields(creating, input.fields);
        });
        this.cache.invalidate(projectId);
        await this.createPhysicalTable(creating, input.fields);
        const active = this.updateTable(projectId, { status: 'active' });
        return { table: active, ingestSecret };
      } catch (error) {
        this.markCreatingTableFailed(projectId);
        throw error;
      }
    });
  }

  deleteTable(projectId: string, confirm: unknown): Promise<TableRecord> {
    return serial(async () => {
      const table = this.requireByIdSync(projectId);
      if (table.status !== 'archived' && table.status !== 'failed') {
        throw new AppError(
          'TABLE_STATE_CONFLICT',
          `Table in status ${table.status} cannot be deleted`,
        );
      }
      this.assertConfirmed(table.displayName, confirm, 'table display name');

      await metaClient.command({
        query: `DROP TABLE IF EXISTS data.${assertIdentifier(table.physicalName)} SYNC`,
      });

      // DESIGN 7.5: ClickHouse 必须先删。若先删 SQLite 后崩溃，随机物理表名失去索引，
      // reconcile 无法再发现孤儿表；反之 DROP 后崩溃可由同一请求幂等收尾。
      this.database.transaction(() => {
        this.statements().deleteFieldsByProjectId.run(projectId);
        const result = this.statements().deleteTableByProjectId.run(projectId);
        if (result.changes !== 1) {
          throw new AppError('TABLE_NOT_FOUND', `Table "${projectId}" was not found`);
        }
      });
      this.cache.invalidate(projectId);
      return table;
    });
  }

  retry(projectId: string): Promise<TableRecord> {
    return serial(async () => {
      let current = this.database.transaction(() => {
        const table = this.requireByIdSync(projectId);
        if (table.status === 'active') {
          return table;
        }
        if (table.status === 'failed') {
          assertTableStatusTransition(table.status, 'creating');
          return this.updateTableRow(table, { status: 'creating' });
        }
        if (table.status !== 'creating') {
          throw new AppError(
            'TABLE_STATE_CONFLICT',
            `Table in status ${table.status} cannot be retried`,
          );
        }
        return table;
      });
      this.cache.invalidate(projectId);
      if (current.status === 'active') {
        return current;
      }

      try {
        const fields = this.listActiveFieldsSync(projectId);
        await this.createPhysicalTable(current, fields);
        current = this.updateTable(projectId, { status: 'active' });
        return current;
      } catch (error) {
        this.markCreatingTableFailed(projectId);
        throw error;
      }
    });
  }

  async setStatus(projectId: string, status: TableStatus): Promise<TableRecord> {
    const updated = this.database.transaction(() => {
      const current = this.requireByIdSync(projectId);
      assertTableStatusTransition(current.status, status);
      return this.updateTableRow(current, { status });
    });
    this.cache.invalidate(projectId);
    return updated;
  }

  async getSecret(projectId: string): Promise<TableRecord> {
    return this.requireByIdSync(projectId);
  }

  async rotateSecret(projectId: string): Promise<TableRecord> {
    const updated = this.database.transaction(() => {
      const current = this.requireByIdSync(projectId);
      return this.updateTableRow(current, {
        ingestSecret: randomBytes(32).toString('base64url'),
        ingestSecretPrev: current.ingestSecret,
        ingestSecretPrevExpiresAt: new Date(
          Date.now() + PREVIOUS_SECRET_GRACE_PERIOD_MS,
        ).toISOString(),
      });
    });
    this.cache.invalidate(projectId);
    return updated;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private statements(): TableStatements {
    this.preparedStatements ??= {
      list: this.database.prepare<CollectTableRow>(`SELECT *
FROM collect_tables
ORDER BY created_at DESC, project_id`),
      listTemplates: this.database.prepare<TableTemplateSummaryRow>(`SELECT
  tables.project_id,
  tables.display_name,
  tables.status,
  count(fields.field_key) AS field_count
FROM collect_tables AS tables
LEFT JOIN collect_fields AS fields
  ON fields.project_id = tables.project_id AND fields.status = 'active'
GROUP BY tables.project_id, tables.display_name, tables.status, tables.created_at
ORDER BY tables.created_at DESC, tables.project_id`),
      findById: this.database.prepare<CollectTableRow>(`SELECT *
FROM collect_tables
WHERE project_id = ?`),
      listFields: this.database.prepare<CollectFieldRow>(`SELECT *
FROM collect_fields
WHERE project_id = ?
ORDER BY field_key`),
      listActiveFields: this.database.prepare<CollectFieldRow>(`SELECT *
FROM collect_fields
WHERE project_id = ? AND status = 'active'
ORDER BY field_key`),
      findField: this.database.prepare<CollectFieldRow>(`SELECT *
FROM collect_fields
WHERE project_id = ? AND field_key = ?`),
      deleteRetiredField: this.database.prepare(`DELETE FROM collect_fields
WHERE project_id = ? AND field_key = ? AND status IN ('dropped', 'renamed')`),
      insertTable: this.database.prepare(`INSERT INTO collect_tables
  (project_id, physical_name, display_name, description, status, schema_version,
   ingest_secret, ingest_secret_prev, ingest_secret_prev_expires_at, created_by, created_at,
   updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      updateTable: this.database.prepare(`UPDATE collect_tables
SET status = ?, schema_version = ?, ingest_secret = ?, ingest_secret_prev = ?,
    ingest_secret_prev_expires_at = ?, updated_at = ?
WHERE project_id = ?`),
      insertField: this.database.prepare(`INSERT INTO collect_fields
  (project_id, field_key, label, type, required, description, status, renamed_to, schema_version,
   created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      updateField: this.database.prepare(`UPDATE collect_fields
SET label = ?, type = ?, required = ?, description = ?, status = ?, renamed_to = ?,
    schema_version = ?, updated_at = ?
WHERE project_id = ? AND field_key = ?`),
      deleteFieldsByProjectId: this.database.prepare(`DELETE FROM collect_fields
WHERE project_id = ?`),
      deleteTableByProjectId: this.database.prepare(`DELETE FROM collect_tables
WHERE project_id = ?`),
    };
    return this.preparedStatements;
  }

  private findByIdSync(projectId: string): TableRecord | null {
    const row = this.statements().findById.get(projectId);
    return row === undefined ? null : mapTable(row);
  }

  private listActiveFieldsSync(projectId: string): ActiveField[] {
    return this.statements().listActiveFields.all(projectId).map(mapField).map(toActiveField);
  }

  private findFieldSync(projectId: string, fieldKey: string): FieldRecord | null {
    const row = this.statements().findField.get(projectId, fieldKey);
    return row === undefined ? null : mapField(row);
  }

  private requireByIdSync(projectId: string): TableRecord {
    const table = this.findByIdSync(projectId);
    if (table === null) {
      throw new AppError('TABLE_NOT_FOUND', `Table "${projectId}" was not found`);
    }
    return table;
  }

  private requireFieldChangeableTableSync(projectId: string): TableRecord {
    const table = this.requireByIdSync(projectId);
    if (table.status !== 'active' && table.status !== 'disabled') {
      throw new AppError(
        'TABLE_STATE_CONFLICT',
        `Fields cannot be changed while table "${projectId}" is ${table.status}`,
      );
    }
    return table;
  }

  private requireActiveFieldSync(projectId: string, fieldKey: string): FieldRecord {
    const field = this.findFieldSync(projectId, fieldKey);
    if (field === null || field.status !== 'active') {
      throw new AppError('FIELD_NOT_FOUND', `Active field "${fieldKey}" was not found`, {
        field: fieldKey,
      });
    }
    return field;
  }

  private requirePhysicalFieldSync(projectId: string, fieldKey: string): FieldRecord {
    const field = this.findFieldSync(projectId, fieldKey);
    if (field === null || (field.status !== 'active' && field.status !== 'deprecated')) {
      throw new AppError('FIELD_NOT_FOUND', `Physical field "${fieldKey}" was not found`, {
        field: fieldKey,
      });
    }
    return field;
  }

  private insertTable(table: TableRecord): void {
    this.statements().insertTable.run(
      table.projectId,
      table.physicalName,
      table.displayName,
      table.description,
      table.status,
      table.schemaVersion,
      table.ingestSecret,
      table.ingestSecretPrev,
      table.ingestSecretPrevExpiresAt,
      table.createdBy,
      table.createdAt,
      table.updatedAt,
    );
  }

  private updateTable(
    projectId: string,
    changes: Partial<
      Pick<
        TableRecord,
        | 'status'
        | 'schemaVersion'
        | 'ingestSecret'
        | 'ingestSecretPrev'
        | 'ingestSecretPrevExpiresAt'
      >
    >,
  ): TableRecord {
    const updated = this.database.transaction(() =>
      this.updateTableRow(this.requireByIdSync(projectId), changes),
    );
    this.cache.invalidate(projectId);
    return updated;
  }

  private updateTableRow(
    current: TableRecord,
    changes: Partial<
      Pick<
        TableRecord,
        | 'status'
        | 'schemaVersion'
        | 'ingestSecret'
        | 'ingestSecretPrev'
        | 'ingestSecretPrevExpiresAt'
      >
    >,
  ): TableRecord {
    const next: TableRecord = {
      ...current,
      ...changes,
      updatedAt: new Date().toISOString(),
    };
    const result = this.statements().updateTable.run(
      next.status,
      next.schemaVersion,
      next.ingestSecret,
      next.ingestSecretPrev,
      next.ingestSecretPrevExpiresAt,
      next.updatedAt,
      next.projectId,
    );
    if (result.changes !== 1) {
      throw new AppError('TABLE_NOT_FOUND', `Table "${next.projectId}" was not found`);
    }
    return next;
  }

  private insertInitialFields(table: TableRecord, fields: readonly CreateFieldInput[]): void {
    const now = new Date().toISOString();
    for (const field of fields) {
      try {
        this.statements().insertField.run(
          table.projectId,
          field.key,
          field.label,
          field.type,
          field.required ? 1 : 0,
          field.description,
          'active',
          '',
          table.schemaVersion,
          now,
          now,
        );
      } catch (error) {
        translateFieldKeyConflict(error, field.key, null);
      }
    }
  }

  private insertFieldRow(projectId: string, field: FieldRecord): void {
    this.statements().insertField.run(
      projectId,
      field.key,
      field.label,
      field.type,
      field.required ? 1 : 0,
      field.description,
      field.status,
      field.renamedTo,
      field.schemaVersion,
      field.createdAt,
      field.updatedAt,
    );
  }

  private updateFieldRow(projectId: string, field: FieldRecord): void {
    const result = this.statements().updateField.run(
      field.label,
      field.type,
      field.required ? 1 : 0,
      field.description,
      field.status,
      field.renamedTo,
      field.schemaVersion,
      field.updatedAt,
      projectId,
      field.key,
    );
    if (result.changes !== 1) {
      throw new AppError('FIELD_NOT_FOUND', `Field "${field.key}" was not found`, {
        field: field.key,
      });
    }
  }

  private async createPhysicalTable(
    table: Pick<TableRecord, 'physicalName'>,
    fields: readonly Pick<CreateFieldInput, 'key' | 'type'>[],
  ): Promise<void> {
    await metaClient.command({ query: buildPhysicalTableDdl(table.physicalName, fields) });
  }

  private async addPhysicalColumn(
    physicalName: string,
    fieldKey: string,
    physicalType: string,
  ): Promise<void> {
    const safePhysicalName = assertIdentifier(physicalName);
    const safeFieldKey = assertValidFieldKey(fieldKey);
    await metaClient.command({
      query: `ALTER TABLE data.${safePhysicalName}
ADD COLUMN IF NOT EXISTS \`${safeFieldKey}\` ${physicalType}`,
    });
  }

  private async physicalColumnNames(physicalName: string): Promise<Set<string>> {
    const rows = await parameterizedQuery<{ name: string }>({
      client: metaClient,
      query: `SELECT name
FROM system.columns
WHERE database = {database:String}
  AND table = {table:String}`,
      params: { database: 'data', table: assertIdentifier(physicalName) },
    });
    return new Set(rows.map((row) => row.name));
  }

  private async renamePhysicalColumn(
    physicalName: string,
    fieldKey: string,
    newFieldKey: string,
  ): Promise<void> {
    const safePhysicalName = assertIdentifier(physicalName);
    const safeFieldKey = assertValidFieldKey(fieldKey);
    const safeNewFieldKey = assertValidFieldKey(newFieldKey);
    // DESIGN 7.3：`RENAME COLUMN` 没有 `IF EXISTS`。上一次 DDL 成功之后若 SQLite 侧中断，
    // 重试会因旧列已不存在而失败，数据反而卡在中间态。先看一眼物理列，
    // 改名已经发生过就直接跳过，让「再点一次 rename」能把元数据补完收尾。
    const columns = await this.physicalColumnNames(safePhysicalName);
    if (!columns.has(safeFieldKey) && columns.has(safeNewFieldKey)) {
      return;
    }
    await metaClient.command({
      query: `ALTER TABLE data.${safePhysicalName}
RENAME COLUMN \`${safeFieldKey}\` TO \`${safeNewFieldKey}\``,
    });
  }

  private async dropPhysicalColumn(physicalName: string, fieldKey: string): Promise<void> {
    const safePhysicalName = assertIdentifier(physicalName);
    const safeFieldKey = assertValidFieldKey(fieldKey);
    await metaClient.command({
      query: `ALTER TABLE data.${safePhysicalName}
DROP COLUMN IF EXISTS \`${safeFieldKey}\``,
    });
  }

  private assertConfirmed(expected: string, confirm: unknown, subject = 'field key'): void {
    if (confirm !== expected) {
      throw new AppError(
        'CONFIRMATION_REQUIRED',
        `Confirmation must exactly match ${subject} "${expected}"`,
        subject === 'field key' ? { field: expected } : {},
      );
    }
  }

  private translateRenameDdlConflict(
    projectId: string,
    source: FieldRecord,
    newFieldKey: string,
    ddlError: unknown,
  ): never {
    const probeRolledBack = Symbol('field key probe rolled back');
    try {
      this.database.transaction(() => {
        this.insertFieldRow(projectId, {
          ...source,
          key: newFieldKey,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        throw probeRolledBack;
      });
    } catch (error) {
      if (error === probeRolledBack) {
        throw ddlError;
      }
      return translateFieldKeyConflict(
        error,
        newFieldKey,
        this.findFieldTx(projectId, newFieldKey),
      );
    }
    throw ddlError;
  }

  // DESIGN 5.2：`dropped` / `renamed` 的墓碑只是「防止同表内 Key 被复用」的记号，
  // 删除它不触碰任何物理列与历史数据——`dropped` 的列早已 DROP，`renamed` 的数据跟着新 Key 走了。
  private retireTombstoneSync(projectId: string, fieldKey: string): void {
    this.statements().deleteRetiredField.run(projectId, fieldKey);
  }

  private findFieldTx(projectId: string, fieldKey: string): FieldRecord | null {
    return this.database.transaction(() => this.findFieldSync(projectId, fieldKey));
  }

  private markCreatingTableFailed(projectId: string): void {
    const updated = this.database.transaction(() => {
      const current = this.findByIdSync(projectId);
      return current?.status === 'creating'
        ? this.updateTableRow(current, { status: 'failed' })
        : null;
    });
    if (updated !== null) {
      this.cache.invalidate(projectId);
    }
  }
}

export const tableRepository = new TableRepository();
