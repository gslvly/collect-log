import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
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
import { physicalTypeFor } from '../domain/tables/schema.js';
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
const testDatabase = openSqliteDatabase(testDataDir);
const metadataCache = new TableMetadataCache();
const tables = new TableRepository(testDatabase, metadataCache);
const apps: FastifyInstance[] = [];

function createLogger(): { logger: ReconcileLogger; entries: LogEntry[] } {
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

async function reconcile(options: Omit<RunReconcileOptions, 'repository'> = {}) {
  return runReconcile({ ...options, repository: tables });
}

async function createFixture(label: string): Promise<{ projectId: string; physicalName: string }> {
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

function overwriteTableStatus(projectId: string, status: TableStatus): void {
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

function overwriteFieldStatus(projectId: string, fieldKey: string, status: FieldStatus): void {
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

async function dropTable(physicalName: string): Promise<void> {
  await serial(async () => {
    await metaClient.command({
      query: `DROP TABLE IF EXISTS data.${assertIdentifier(physicalName)} SYNC`,
    });
  });
}

async function addColumn(
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

async function renameColumn(
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

async function insertRow(physicalName: string, values: Record<string, unknown>): Promise<void> {
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

async function dropColumn(physicalName: string, fieldKey: string): Promise<void> {
  await serial(async () => {
    await metaClient.command({
      query: `ALTER TABLE data.${assertIdentifier(physicalName)}
DROP COLUMN IF EXISTS \`${assertIdentifier(fieldKey)}\``,
    });
  });
}

async function systemColumns(
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

describe('startup reconcile against independent SQLite and ClickHouse', () => {
  it('promotes a creating table when its physical table exists', async () => {
    const fixture = await createFixture('creating-existing');
    overwriteTableStatus(fixture.projectId, 'creating');
    await tables.getDefinition(fixture.projectId);
    expect(metadataCache.has(fixture.projectId)).toBe(true);

    const result = await reconcile();

    await expect(tables.findById(fixture.projectId)).resolves.toMatchObject({ status: 'active' });
    expect(metadataCache.has(fixture.projectId)).toBe(false);
    expect(result).toMatchObject({ fixed: 1, failed: 0 });
  });

  it('marks a creating table failed when its physical table is absent', async () => {
    const fixture = await createFixture('creating-missing');
    await dropTable(fixture.physicalName);
    overwriteTableStatus(fixture.projectId, 'creating');

    const result = await reconcile();

    await expect(tables.findById(fixture.projectId)).resolves.toMatchObject({ status: 'failed' });
    expect(result).toMatchObject({ fixed: 1, failed: 0 });
  });

  it('promotes a failed table through the legal creating intermediate state', async () => {
    const fixture = await createFixture('failed-existing');
    overwriteTableStatus(fixture.projectId, 'failed');
    const setStatus = vi.spyOn(tables, 'setStatus');

    const result = await reconcile();

    expect(setStatus.mock.calls).toEqual([
      [fixture.projectId, 'creating'],
      [fixture.projectId, 'active'],
    ]);
    await expect(tables.findById(fixture.projectId)).resolves.toMatchObject({ status: 'active' });
    expect(result).toMatchObject({ fixed: 1, failed: 0 });
  });

  it('leaves a failed table without a physical table untouched', async () => {
    const fixture = await createFixture('failed-missing');
    await dropTable(fixture.physicalName);
    overwriteTableStatus(fixture.projectId, 'failed');
    const setStatus = vi.spyOn(tables, 'setStatus');

    const result = await reconcile();

    expect(setStatus).not.toHaveBeenCalled();
    await expect(tables.findById(fixture.projectId)).resolves.toMatchObject({ status: 'failed' });
    expect(result).toMatchObject({ fixed: 0, failed: 0 });
  });

  it('restores a missing active column with the metadata-derived physical type', async () => {
    const fixture = await createFixture('missing-active-column');
    await dropColumn(fixture.physicalName, 'is_success');
    await tables.getDefinition(fixture.projectId);
    expect(metadataCache.has(fixture.projectId)).toBe(true);

    const result = await reconcile();

    expect(await systemColumns(fixture.physicalName, ['is_success'])).toEqual([
      { name: 'is_success', type: physicalTypeFor('boolean') },
    ]);
    expect(metadataCache.has(fixture.projectId)).toBe(false);
    expect(result).toMatchObject({ fixed: 1, failed: 0 });
  });

  // DESIGN 7.3 的 rename 中间态：DDL 生效、SQLite 事务没提交。
  // 补空列会把数据永久留在孤儿列里，因此必须反向改回来。
  it('reverts an interrupted rename instead of adding an empty column', async () => {
    const fixture = await createFixture('interrupted-rename');
    await insertRow(fixture.physicalName, { event_name: 'checkout', is_success: true });
    await renameColumn(fixture.physicalName, 'event_name', 'event_kind');
    const { logger, entries } = createLogger();

    const result = await reconcile({ logger });

    expect(await systemColumns(fixture.physicalName, ['event_kind', 'event_name'])).toEqual([
      { name: 'event_name', type: physicalTypeFor('string') },
    ]);
    const rows = await parameterizedQuery<{ event_name: string | null }>({
      client: metaClient,
      query: `SELECT event_name
FROM data.${assertIdentifier(fixture.physicalName)}`,
      params: {},
    });
    expect(rows).toEqual([{ event_name: 'checkout' }]);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'info',
        bindings: expect.objectContaining({
          operation: 'reconcile_revert_rename',
          projectId: fixture.projectId,
          fieldKey: 'event_name',
          orphanColumn: 'event_kind',
        }),
      }),
    );
    expect(result).toMatchObject({ fixed: 1, failed: 0 });
  });

  it('does not mistake a differently typed orphan column for an interrupted rename', async () => {
    const fixture = await createFixture('orphan-type-mismatch');
    await dropColumn(fixture.physicalName, 'event_name');
    await addColumn(fixture.physicalName, 'event_kind', physicalTypeFor('boolean'));
    const { logger, entries } = createLogger();

    const result = await reconcile({ logger });

    expect(await systemColumns(fixture.physicalName, ['event_kind', 'event_name'])).toEqual([
      { name: 'event_kind', type: physicalTypeFor('boolean') },
      { name: 'event_name', type: physicalTypeFor('string') },
    ]);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        bindings: expect.objectContaining({
          operation: 'reconcile_unmanaged_column',
          fieldKey: 'event_kind',
        }),
      }),
    );
    expect(result).toMatchObject({ fixed: 1, failed: 0 });
  });

  it('warns but preserves a physical column with no metadata row', async () => {
    const fixture = await createFixture('unmanaged-column');
    await addColumn(fixture.physicalName, 'orphan_column');
    const { logger, entries } = createLogger();

    const result = await reconcile({ logger });

    expect(await systemColumns(fixture.physicalName, ['orphan_column'])).toEqual([
      { name: 'orphan_column', type: 'Nullable(String)' },
    ]);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        bindings: expect.objectContaining({
          operation: 'reconcile_unmanaged_column',
          projectId: fixture.projectId,
          physicalName: fixture.physicalName,
          fieldKey: 'orphan_column',
        }),
      }),
    );
    expect(result).toMatchObject({ fixed: 0, failed: 0 });
  });

  it('drops a physical column whose metadata is a dropped tombstone', async () => {
    const fixture = await createFixture('dropped-column');
    overwriteFieldStatus(fixture.projectId, 'event_name', 'dropped');
    await tables.getDefinition(fixture.projectId);
    expect(metadataCache.has(fixture.projectId)).toBe(true);

    const result = await reconcile();

    expect(await systemColumns(fixture.physicalName, ['event_name'])).toEqual([]);
    expect(metadataCache.has(fixture.projectId)).toBe(false);
    expect(result).toMatchObject({ fixed: 1, failed: 0 });
  });

  it('retains the physical column for deprecated metadata', async () => {
    const fixture = await createFixture('deprecated-column');
    overwriteFieldStatus(fixture.projectId, 'event_name', 'deprecated');

    const result = await reconcile();

    expect(await systemColumns(fixture.physicalName, ['event_name'])).toEqual([
      { name: 'event_name', type: physicalTypeFor('string') },
    ]);
    expect(result).toMatchObject({ fixed: 0, failed: 0 });
  });

  it('drops a stale physical column whose metadata is a renamed tombstone', async () => {
    const fixture = await createFixture('renamed-column');
    overwriteFieldStatus(fixture.projectId, 'event_name', 'renamed');

    const result = await reconcile();

    expect(await systemColumns(fixture.physicalName, ['event_name'])).toEqual([]);
    expect(result).toMatchObject({ fixed: 1, failed: 0 });
  });

  it('continues repairing other active tables when one table repair fails', async () => {
    const broken = await createFixture('broken-active-table');
    const healthy = await createFixture('healthy-active-table');
    await dropTable(broken.physicalName);
    await dropColumn(healthy.physicalName, 'is_success');
    const { logger, entries } = createLogger();

    const result = await reconcile({ logger });

    expect(await systemColumns(healthy.physicalName, ['is_success'])).toEqual([
      { name: 'is_success', type: physicalTypeFor('boolean') },
    ]);
    expect(result.fixed).toBe(1);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        bindings: expect.objectContaining({
          operation: 'reconcile_add_column',
          projectId: broken.projectId,
          physicalName: broken.physicalName,
          err: expect.anything(),
        }),
      }),
    );
  });

  it('exposes the completed reconcile result through healthz without physical names', async () => {
    const result = await reconcile();
    const app = await buildApp({
      tableRepository: tables,
      pingClickHouse: () => Promise.resolve(),
      pingSqlite: () => Promise.resolve(),
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/healthz' });
    const payload = response.json() as Record<string, unknown>;

    expect(response.statusCode).toBe(200);
    expect(Object.keys(payload).sort()).toEqual(
      ['status', 'uptimeSeconds', 'clickhouse', 'sqlite', 'lastReconcile'].sort(),
    );
    expect(payload.lastReconcile).toEqual(result);
    expect(result.at).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(result.at))).toBe(false);
    expect(response.body).not.toContain('physicalName');
    expect(response.body).not.toContain('physical_name');
  });

  it('repairs drift on disabled tables because field changes are allowed there', async () => {
    const fixture = await createFixture('disabled-table');
    overwriteTableStatus(fixture.projectId, 'disabled');
    await dropColumn(fixture.physicalName, 'is_success');

    const result = await reconcile();

    expect(await systemColumns(fixture.physicalName, ['is_success'])).toEqual([
      { name: 'is_success', type: 'Nullable(Bool)' },
    ]);
    expect(result).toMatchObject({ fixed: 1, failed: 0 });
  });

  it('only warns when an archived table is missing after a partial deletion', async () => {
    const fixture = await createFixture('archived-partial-deletion');
    overwriteTableStatus(fixture.projectId, 'archived');
    await dropTable(fixture.physicalName);
    const { logger, entries } = createLogger();
    const command = vi.spyOn(metaClient, 'command');

    const result = await reconcile({ logger });

    expect(command).not.toHaveBeenCalled();
    await expect(tables.findById(fixture.projectId)).resolves.toMatchObject({
      status: 'archived',
    });
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        bindings: expect.objectContaining({
          operation: 'reconcile_incomplete_table_deletion',
          projectId: fixture.projectId,
          physicalName: fixture.physicalName,
        }),
      }),
    );
    expect(result).toMatchObject({ fixed: 0, failed: 0 });
  });

  it('skips drift repair for archived tables', async () => {
    const fixture = await createFixture('archived-table');
    overwriteTableStatus(fixture.projectId, 'archived');
    await dropColumn(fixture.physicalName, 'is_success');

    const result = await reconcile();

    expect(await systemColumns(fixture.physicalName, ['is_success'])).toEqual([]);
    expect(result).toMatchObject({ fixed: 0, failed: 0 });
  });
});
