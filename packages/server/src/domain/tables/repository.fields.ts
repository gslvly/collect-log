import { configuredLimits } from '../../config/limits.js';
import { AppError } from '../../errors.js';
import { assertIdentifier, parameterizedQuery, readonlyClient } from '../../infra/clickhouse.js';
import { serial } from '../../infra/serial.js';
import { isSqliteConstraintConflict } from '../../infra/sqlite.js';
import { RepositoryBase } from './repository.base.js';
import {
  addPhysicalColumn,
  dropPhysicalColumn,
  renamePhysicalColumn,
  retypePhysicalColumn,
} from './repository.physical.js';
import { translateFieldKeyConflict } from './repository.rows.js';
import { assertValidFieldKey, physicalTypeFor, validateFieldOptions } from './schema.js';
import type {
  CreateFieldInput,
  FieldOptionInput,
  FieldRecord,
  RetypeFieldInput,
  TableRecord,
  UpdateFieldInput,
} from './types.js';

export interface FieldChangeResult {
  table: TableRecord;
  field: FieldRecord;
}

export abstract class FieldRepository extends RepositoryBase {
  addField(projectId: string, input: CreateFieldInput): Promise<FieldChangeResult> {
    const fieldKey = assertValidFieldKey(input.key);
    const physicalType = physicalTypeFor(input.type);
    validateFieldOptions(input, configuredLimits.schema);

    return serial(async () => {
      const table = this.database.transaction(() =>
        this.requireFieldChangeableTableSync(projectId),
      );
      await addPhysicalColumn(table.physicalName, fieldKey, physicalType);

      try {
        const changed = this.database.transaction(() => {
          const current = this.requireFieldChangeableTableSync(projectId);
          const schemaVersion = current.schemaVersion + 1;
          const now = new Date().toISOString();
          const field: FieldRecord = {
            key: fieldKey,
            label: input.label,
            type: input.type,
            required: input.required,
            description: input.description,
            options: (input.options ?? []).map((option) => ({ ...option })),
            status: 'active',
            renamedTo: '',
            schemaVersion,
            createdAt: now,
            updatedAt: now,
          };
          this.retireTombstoneSync(projectId, fieldKey);
          this.insertFieldRow(projectId, field);
          this.insertFieldOptions(projectId, fieldKey, input.options ?? [], now);
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

  async updateFieldOptions(
    projectId: string,
    fieldKey: string,
    options: FieldOptionInput[],
  ): Promise<FieldChangeResult> {
    const safeFieldKey = assertValidFieldKey(fieldKey);
    const changed = this.database.transaction(() => {
      const table = this.requireFieldChangeableTableSync(projectId);
      const current = this.requireActiveFieldSync(projectId, safeFieldKey);
      if (current.type !== 'enum') {
        throw new AppError(
          'INVALID_FIELD_VALUE',
          `Field "${safeFieldKey}" has type "${current.type}" and cannot define enum options`,
          { field: safeFieldKey },
        );
      }

      validateFieldOptions({ ...current, options }, configuredLimits.schema);
      const submittedValues = new Set(options.map((option) => option.value));
      const missingValues = current.options
        .filter((option) => !submittedValues.has(option.value))
        .map((option) => option.value);
      if (missingValues.length > 0) {
        throw new AppError(
          'INVALID_FIELD_VALUE',
          `Enum option update omitted existing values ${missingValues.map((value) => `"${value}"`).join(', ')}; submit them with status "disabled" to disable them`,
          { field: safeFieldKey },
        );
      }

      const existingByValue = new Map(current.options.map((option) => [option.value, option]));
      const changesValidation = options.some((option) => {
        const existing = existingByValue.get(option.value);
        return existing === undefined || existing.status !== option.status;
      });
      const schemaVersion = table.schemaVersion + (changesValidation ? 1 : 0);
      const now = new Date().toISOString();
      for (const [sortOrder, option] of options.entries()) {
        if (existingByValue.has(option.value)) {
          this.statements().updateFieldOption.run(
            option.label,
            option.status,
            sortOrder,
            now,
            projectId,
            safeFieldKey,
            option.value,
          );
        } else {
          this.statements().insertFieldOption.run(
            projectId,
            safeFieldKey,
            option.value,
            option.label,
            option.status,
            sortOrder,
            now,
            now,
          );
        }
      }

      const field: FieldRecord = {
        ...current,
        options: options.map((option) => ({ ...option })),
        schemaVersion: changesValidation ? schemaVersion : current.schemaVersion,
        updatedAt: now,
      };
      this.updateFieldRow(projectId, field);
      return {
        table: this.updateTableRow(table, { schemaVersion }),
        field,
      };
    });
    this.cache.invalidate(projectId);
    return changed;
  }

  retypeField(
    projectId: string,
    fieldKey: string,
    input: RetypeFieldInput,
  ): Promise<FieldChangeResult> {
    const safeFieldKey = assertValidFieldKey(fieldKey);

    return serial(async () => {
      const context = this.database.transaction(() => {
        const table = this.requireFieldChangeableTableSync(projectId);
        const field = this.requireActiveFieldSync(projectId, safeFieldKey);
        this.validateRetypeInput(field, input);
        return { table, field };
      });
      await retypePhysicalColumn(context.table.physicalName, safeFieldKey, input.type);

      const changed = this.database.transaction(() => {
        const table = this.requireFieldChangeableTableSync(projectId);
        const current = this.requireActiveFieldSync(projectId, safeFieldKey);
        this.validateRetypeInput(current, input);
        const schemaVersion = table.schemaVersion + 1;
        const now = new Date().toISOString();
        const options = input.type === 'enum' ? (input.options ?? []) : [];
        if (input.type === 'enum') {
          this.insertFieldOptions(projectId, safeFieldKey, options, now);
        } else {
          this.statements().deleteFieldOptions.run(projectId, safeFieldKey);
        }
        const field: FieldRecord = {
          ...current,
          type: input.type,
          options: options.map((option) => ({ ...option })),
          schemaVersion,
          updatedAt: now,
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
        await renamePhysicalColumn(context.table.physicalName, safeFieldKey, safeNewFieldKey);
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
          this.statements().renameFieldOptions.run(safeNewFieldKey, now, projectId, safeFieldKey);
          return {
            table: this.updateTableRow(table, { schemaVersion }),
            field,
          };
        });
        this.cache.invalidate(projectId);
        return changed;
      } catch (error) {
        if (isSqliteConstraintConflict(error)) {
          await renamePhysicalColumn(context.table.physicalName, safeNewFieldKey, safeFieldKey);
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
        field: this.requirePhysicalFieldSync(projectId, safeFieldKey),
      }));
      await dropPhysicalColumn(context.table.physicalName, safeFieldKey);

      const changed = this.database.transaction(() => {
        const table = this.requireFieldChangeableTableSync(projectId);
        const current = this.requirePhysicalFieldSync(projectId, safeFieldKey);
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

  private validateRetypeInput(current: FieldRecord, input: RetypeFieldInput): void {
    const directionAllowed =
      (current.type === 'string' && input.type === 'enum') ||
      (current.type === 'enum' && input.type === 'string');
    if (!directionAllowed) {
      throw new AppError(
        'INVALID_FIELD_TYPE',
        `Field "${current.key}" cannot be converted from "${current.type}" to "${input.type}"`,
        { field: current.key },
      );
    }
    validateFieldOptions(
      {
        key: current.key,
        label: current.label,
        type: input.type,
        required: current.required,
        description: current.description,
        ...(input.options === undefined ? {} : { options: input.options }),
      },
      configuredLimits.schema,
    );
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
}
