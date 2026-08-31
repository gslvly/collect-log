import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';

import {
  assertIdentifier,
  ingestClient,
  metaClient,
  parameterizedQuery,
} from '../infra/clickhouse.js';
import { serial } from '../infra/serial.js';
import { openSqliteDatabase } from '../infra/sqlite.js';
import { TableMetadataCache } from '../domain/tables/cache.js';
import { TableRepository } from '../domain/tables/repository.js';
import type { FieldStatus, TableStatus } from '../domain/tables/types.js';
import { bootstrapSchema } from './schema.js';
import { runReconcile, type ReconcileLogger, type RunReconcileOptions } from './reconcile.js';

interface TableCleanupRow {
  physical_name: string;
}

interface SystemColumnRow {
  name: string;
  type: string;
}

interface LogEntry {
  level: 'info' | 'warn' | 'error';
  bindings: Record<string, unknown>;
  message: string;
}

const namespace = `stageb_${randomUUID().replaceAll('-', '')}`;
const testDataDir = mkdtempSync(join(tmpdir(), 'collect-log-reconcile-'));
export const testDatabase = openSqliteDatabase(testDataDir);
export const metadataCache = new TableMetadataCache();
export const tables = new TableRepository(testDatabase, metadataCache);
export const apps: FastifyInstance[] = [];

export function createLogger(): { logger: ReconcileLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    logger: {
      info: (bindings, message) => entries.push({ level: 'info', bindings, message }),
      warn: (bindings, message) => entries.push({ level: 'warn', bindings, message }),
      error: (bindings, message) => entries.push({ level: 'error', bindings, message }),
    },
    entries,
  };
}

export async function reconcile(options: Omit<RunReconcileOptions, 'repository'> = {}) {
  return runReconcile({ ...options, repository: tables });
}

export async function createFixture(
  label: string,
): Promise<{ projectId: string; physicalName: string }> {
  const { table } = await tables.create(
    {
      displayName: `${namespace}-${label}`,
      description: `reconcile fixture ${label}`,
      fields: [
        {
          key: 'event_name',
          label: 'Event name',
          type: 'string',
          required: true,
          description: '',
        },
        {
          key: 'is_success',
          label: 'Success',
          type: 'boolean',
          required: false,
          description: '',
        },
      ],
    },
    namespace,
  );
  return { projectId: table.projectId, physicalName: table.physicalName };
}

export function overwriteTableStatus(projectId: string, status: TableStatus): void {
  testDatabase.transaction(() => {
    const result = testDatabase
      .prepare(
        `UPDATE collect_tables
SET status = ?, updated_at = ?
WHERE project_id = ?`,
      )
      .run(status, new Date().toISOString(), projectId);
    if (result.changes !== 1) {
      throw new Error(`Fixture table ${projectId} was not found`);
    }
  });
  tables.clearCache();
}

export function overwriteFieldStatus(
  projectId: string,
  fieldKey: string,
  status: FieldStatus,
): void {
  testDatabase.transaction(() => {
    const result = testDatabase
      .prepare(
        `UPDATE collect_fields
SET status = ?, renamed_to = ?, updated_at = ?
WHERE project_id = ? AND field_key = ?`,
      )
      .run(
        status,
        status === 'renamed' ? `${fieldKey}_next` : '',
        new Date().toISOString(),
        projectId,
        fieldKey,
      );
    if (result.changes !== 1) {
      throw new Error(`Fixture field ${projectId}.${fieldKey} was not found`);
    }
  });
  tables.clearCache();
}

export async function dropTable(physicalName: string): Promise<void> {
  await serial(async () => {
    await metaClient.command({
      query: `DROP TABLE IF EXISTS data.${assertIdentifier(physicalName)} SYNC`,
    });
  });
}

export async function addColumn(
  physicalName: string,
  fieldKey: string,
  physicalType = 'Nullable(String)',
): Promise<void> {
  await serial(async () => {
    await metaClient.command({
      query: `ALTER TABLE data.${assertIdentifier(physicalName)}
ADD COLUMN IF NOT EXISTS \`${assertIdentifier(fieldKey)}\` ${physicalType}`,
    });
  });
}

export async function renameColumn(
  physicalName: string,
  fieldKey: string,
  newFieldKey: string,
): Promise<void> {
  await serial(async () => {
    await metaClient.command({
      query: `ALTER TABLE data.${assertIdentifier(physicalName)}
RENAME COLUMN \`${assertIdentifier(fieldKey)}\` TO \`${assertIdentifier(newFieldKey)}\``,
    });
  });
}

export async function modifyColumn(
  physicalName: string,
  fieldKey: string,
  physicalType: string,
): Promise<void> {
  await serial(async () => {
    await metaClient.command({
      query: `ALTER TABLE data.${assertIdentifier(physicalName)}
MODIFY COLUMN \`${assertIdentifier(fieldKey)}\` ${physicalType}`,
    });
  });
}

export async function insertRow(
  physicalName: string,
  values: Record<string, unknown>,
): Promise<void> {
  await ingestClient.insert({
    table: `data.${assertIdentifier(physicalName)}`,
    values: [
      {
        _record_id: randomUUID(),
        _schema_version: 1,
        _occurred_at: '2026-08-28 08:00:00.000',
        ...values,
      },
    ],
    format: 'JSONEachRow',
  });
}

export async function dropColumn(physicalName: string, fieldKey: string): Promise<void> {
  await serial(async () => {
    await metaClient.command({
      query: `ALTER TABLE data.${assertIdentifier(physicalName)}
DROP COLUMN IF EXISTS \`${assertIdentifier(fieldKey)}\``,
    });
  });
}

export async function systemColumns(
  physicalName: string,
  names: readonly string[],
): Promise<SystemColumnRow[]> {
  return parameterizedQuery<SystemColumnRow>({
    client: metaClient,
    query: `SELECT name, type
FROM system.columns
WHERE database = {database:String}
  AND table = {table:String}
  AND name IN ({names:Array(String)})
ORDER BY name`,
    params: { database: 'data', table: physicalName, names },
  });
}

async function cleanupTables(): Promise<void> {
  tables.clearCache();
  const rows = testDatabase
    .prepare<TableCleanupRow>(
      `SELECT physical_name
FROM collect_tables`,
    )
    .all();

  await serial(async () => {
    for (const row of rows) {
      await metaClient.command({
        query: `DROP TABLE IF EXISTS data.${assertIdentifier(row.physical_name)} SYNC`,
      });
    }
    testDatabase.transaction(() => {
      testDatabase.prepare('DELETE FROM collect_fields').run();
      testDatabase.prepare('DELETE FROM collect_tables').run();
    });
  });
}

beforeAll(async () => {
  await bootstrapSchema(testDatabase);
  await cleanupTables();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await cleanupTables();
});

afterAll(async () => {
  await cleanupTables();
  testDatabase.close();
  rmSync(testDataDir, { recursive: true, force: true });
});
