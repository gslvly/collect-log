import { AppError } from '../../errors.js';
import { metaClient } from '../../infra/clickhouse.js';
import { sqliteDatabase, type SqliteDatabase } from '../../infra/sqlite.js';
import { TableMetadataCache, tableMetadataCache } from './cache.js';
import {
  groupFieldOptions,
  mapField,
  mapFieldOption,
  mapTable,
  mapTableTemplateSummary,
  toActiveField,
  toTemplateField,
  translateFieldKeyConflict,
} from './repository.rows.js';
import {
  prepareTableStatements,
  type TableStatements,
} from './repository.statements.js';
import { buildPhysicalTableDdl } from './schema.js';
import type {
  ActiveField,
  CreateFieldInput,
  FieldOptionInput,
  FieldRecord,
  TableDefinition,
  TableRecord,
  TableTemplate,
  TableTemplateSummary,
} from './types.js';

export abstract class RepositoryBase {
  private preparedStatements: TableStatements | undefined;

  constructor(
    protected readonly database: SqliteDatabase = sqliteDatabase,
    protected readonly cache: TableMetadataCache = tableMetadataCache,
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
    const optionsByField = groupFieldOptions(this.statements().listAllFieldOptions.all(projectId));
    return this.statements()
      .listFields.all(projectId)
      .map((row) => mapField(row, optionsByField.get(row.field_key) ?? []));
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

  clearCache(): void {
    this.cache.clear();
  }

  protected statements(): TableStatements {
    this.preparedStatements ??= prepareTableStatements(this.database);
    return this.preparedStatements;
  }

  protected findByIdSync(projectId: string): TableRecord | null {
    const row = this.statements().findById.get(projectId);
    return row === undefined ? null : mapTable(row);
  }

  protected listActiveFieldsSync(projectId: string): ActiveField[] {
    const optionsByField = new Map<string, Map<string, string>>();
    for (const option of this.statements().listActiveFieldOptions.all(projectId)) {
      let fieldOptions = optionsByField.get(option.field_key);
      if (fieldOptions === undefined) {
        fieldOptions = new Map<string, string>();
        optionsByField.set(option.field_key, fieldOptions);
      }
      fieldOptions.set(option.value, option.label);
    }
    return this.statements()
      .listActiveFields.all(projectId)
      .map((row) => mapField(row))
      .map((field) => toActiveField(field, optionsByField.get(field.key) ?? new Map()));
  }

  protected findFieldSync(projectId: string, fieldKey: string): FieldRecord | null {
    const row = this.statements().findField.get(projectId, fieldKey);
    if (row === undefined) {
      return null;
    }
    const options = this.statements()
      .listFieldOptions.all(projectId, fieldKey)
      .map(mapFieldOption);
    return mapField(row, options);
  }

  protected requireByIdSync(projectId: string): TableRecord {
    const table = this.findByIdSync(projectId);
    if (table === null) {
      throw new AppError('TABLE_NOT_FOUND', `Table "${projectId}" was not found`);
    }
    return table;
  }

  protected requireFieldChangeableTableSync(projectId: string): TableRecord {
    const table = this.requireByIdSync(projectId);
    if (table.status !== 'active' && table.status !== 'disabled') {
      throw new AppError(
        'TABLE_STATE_CONFLICT',
        `Fields cannot be changed while table "${projectId}" is ${table.status}`,
      );
    }
    return table;
  }

  protected requireActiveFieldSync(projectId: string, fieldKey: string): FieldRecord {
    const field = this.findFieldSync(projectId, fieldKey);
    if (field === null || field.status !== 'active') {
      throw new AppError('FIELD_NOT_FOUND', `Active field "${fieldKey}" was not found`, {
        field: fieldKey,
      });
    }
    return field;
  }

  protected requirePhysicalFieldSync(projectId: string, fieldKey: string): FieldRecord {
    const field = this.findFieldSync(projectId, fieldKey);
    if (field === null || (field.status !== 'active' && field.status !== 'deprecated')) {
      throw new AppError('FIELD_NOT_FOUND', `Physical field "${fieldKey}" was not found`, {
        field: fieldKey,
      });
    }
    return field;
  }

  protected insertTable(table: TableRecord): void {
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

  protected updateTable(
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

  protected updateTableRow(
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

  protected insertInitialFields(table: TableRecord, fields: readonly CreateFieldInput[]): void {
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
        this.insertFieldOptions(table.projectId, field.key, field.options ?? [], now);
      } catch (error) {
        translateFieldKeyConflict(error, field.key, null);
      }
    }
  }

  protected insertFieldRow(projectId: string, field: FieldRecord): void {
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

  protected insertFieldOptions(
    projectId: string,
    fieldKey: string,
    options: readonly FieldOptionInput[],
    now: string,
  ): void {
    for (const [sortOrder, option] of options.entries()) {
      this.statements().insertFieldOption.run(
        projectId,
        fieldKey,
        option.value,
        option.label,
        option.status,
        sortOrder,
        now,
        now,
      );
    }
  }

  protected updateFieldRow(projectId: string, field: FieldRecord): void {
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

  protected async createPhysicalTable(
    table: Pick<TableRecord, 'physicalName'>,
    fields: readonly Pick<CreateFieldInput, 'key' | 'type'>[],
  ): Promise<void> {
    await metaClient.command({ query: buildPhysicalTableDdl(table.physicalName, fields) });
  }

  protected assertConfirmed(expected: string, confirm: unknown, subject = 'field key'): void {
    if (confirm !== expected) {
      throw new AppError(
        'CONFIRMATION_REQUIRED',
        `Confirmation must exactly match ${subject} "${expected}"`,
        subject === 'field key' ? { field: expected } : {},
      );
    }
  }

  // DESIGN 5.2：`dropped` / `renamed` 的墓碑只是「防止同表内 Key 被复用」的记号，
  // 删除它不触碰任何物理列与历史数据——`dropped` 的列早已 DROP，`renamed` 的数据跟着新 Key 走了。
  protected retireTombstoneSync(projectId: string, fieldKey: string): void {
    this.statements().deleteRetiredField.run(projectId, fieldKey);
  }

  protected findFieldTx(projectId: string, fieldKey: string): FieldRecord | null {
    return this.database.transaction(() => this.findFieldSync(projectId, fieldKey));
  }

  protected markCreatingTableFailed(projectId: string): void {
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
