import { randomBytes } from 'node:crypto';

import { ulid } from 'ulid';

import { configuredLimits } from '../../config/limits.js';
import { AppError } from '../../errors.js';
import { assertIdentifier, metaClient } from '../../infra/clickhouse.js';
import { serial } from '../../infra/serial.js';
import { FieldRepository } from './repository.fields.js';
import { validateInitialFields } from './schema.js';
import { assertTableStatusTransition } from './state-machine.js';
import type { CreateTableInput, TableRecord, TableStatus } from './types.js';

export interface CreateTableResult {
  table: TableRecord;
  ingestSecret: string;
}

const PREVIOUS_SECRET_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1_000;

export class TableRepository extends FieldRepository {
  create(input: CreateTableInput, operator: string): Promise<CreateTableResult> {
    validateInitialFields(input.fields, configuredLimits.schema);
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
}
