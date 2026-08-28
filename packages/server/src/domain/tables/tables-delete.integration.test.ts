import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { bootstrapSchema } from '../../bootstrap/schema.js';
import { assertIdentifier, metaClient, parameterizedQuery } from '../../infra/clickhouse.js';
import { serial } from '../../infra/serial.js';
import { openSqliteDatabase } from '../../infra/sqlite.js';
import type { UserRole } from '../users/types.js';
import { TableMetadataCache } from './cache.js';
import { TableRepository } from './repository.js';
import type { TableStatus } from './types.js';

interface TableCleanupRow {
  physical_name: string;
}

interface SystemTableRow {
  name: string;
}

interface CountRow {
  count: number;
}

const namespace = `stageb2_delete_${randomUUID().replaceAll('-', '')}`;
const testDataDir = mkdtempSync(join(tmpdir(), 'collect-log-table-delete-'));
const testDatabase = openSqliteDatabase(testDataDir);
const metadataCache = new TableMetadataCache();
const tables = new TableRepository(testDatabase, metadataCache);
const apps: FastifyInstance[] = [];

function authorization(app: FastifyInstance, role: UserRole): { authorization: string } {
  const token = app.jwt.sign({ username: `${namespace}_${role}`, role });
  return { authorization: `Bearer ${token}` };
}

async function makeApp(): Promise<FastifyInstance> {
  const app = await buildApp({ tableRepository: tables });
  apps.push(app);
  return app;
}

async function createFixture(
  app: FastifyInstance,
  label: string,
): Promise<{ projectId: string; displayName: string; physicalName: string }> {
  const displayName = `${namespace}_${label}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/tables',
    headers: authorization(app, 'super_admin'),
    payload: {
      displayName,
      description: `delete fixture ${label}`,
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
  });
  expect(response.statusCode, response.body).toBe(200);
  const projectId = response.json().projectId as string;
  const table = await tables.findById(projectId);
  if (table === null) {
    throw new Error(`Fixture table ${projectId} was not persisted`);
  }
  return { projectId, displayName, physicalName: table.physicalName };
}

function overwriteStatus(projectId: string, status: TableStatus): void {
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

async function dropPhysicalTable(physicalName: string): Promise<void> {
  await serial(async () => {
    await metaClient.command({
      query: `DROP TABLE IF EXISTS data.${assertIdentifier(physicalName)} SYNC`,
    });
  });
}

async function physicalTableRows(physicalName: string): Promise<SystemTableRow[]> {
  return parameterizedQuery<SystemTableRow>({
    client: metaClient,
    query: `SELECT name
FROM system.tables
WHERE database = {database:String}
  AND name = {name:String}`,
    params: { database: 'data', name: physicalName },
  });
}

function metadataCount(table: 'collect_tables' | 'collect_fields', projectId: string): number {
  return (
    testDatabase
      .prepare<CountRow>(`SELECT count(*) AS count FROM ${table} WHERE project_id = ?`)
      .get(projectId)?.count ?? -1
  );
}

async function cleanupTables(): Promise<void> {
  tables.clearCache();
  const rows = testDatabase
    .prepare<TableCleanupRow>('SELECT physical_name FROM collect_tables')
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
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await cleanupTables();
});

afterAll(async () => {
  await cleanupTables();
  testDatabase.close();
  rmSync(testDataDir, { recursive: true, force: true });
});

describe('stage B-2 collection table deletion', () => {
  it('denies admin before entering the destructive workflow', async () => {
    const app = await makeApp();
    const fixture = await createFixture(app, 'admin-forbidden');

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/tables/${fixture.projectId}`,
      headers: authorization(app, 'admin'),
      payload: { confirm: fixture.displayName },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('returns TABLE_NOT_FOUND for a valid but unknown projectId', async () => {
    const app = await makeApp();
    const projectId = `prj_${ulid()}`;

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/tables/${projectId}`,
      headers: authorization(app, 'super_admin'),
      payload: { confirm: 'missing table' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'TABLE_NOT_FOUND' } });
  });

  it.each(['active', 'disabled', 'creating'] as const)(
    'rejects the %s status with TABLE_STATE_CONFLICT',
    async (status) => {
      const app = await makeApp();
      const fixture = await createFixture(app, `state-${status}`);
      overwriteStatus(fixture.projectId, status);

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/admin/tables/${fixture.projectId}`,
        headers: authorization(app, 'super_admin'),
        payload: { confirm: fixture.displayName },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'TABLE_STATE_CONFLICT' } });
      expect(await physicalTableRows(fixture.physicalName)).toEqual([
        { name: fixture.physicalName },
      ]);
    },
  );

  it.each([
    ['missing', undefined],
    ['projectId', 'projectId'],
    ['wrong', 'wrong display name'],
  ] as const)('requires an exact displayName confirmation when it is %s', async (kind, value) => {
    const app = await makeApp();
    const fixture = await createFixture(app, `confirm-${kind}`);
    overwriteStatus(fixture.projectId, 'archived');
    const payload =
      kind === 'missing'
        ? undefined
        : { confirm: value === 'projectId' ? fixture.projectId : value };

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/tables/${fixture.projectId}`,
      headers: authorization(app, 'super_admin'),
      ...(payload === undefined ? {} : { payload }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED' } });
    expect(metadataCount('collect_tables', fixture.projectId)).toBe(1);
  });

  it('deletes an archived physical table, all metadata and tombstones, then invalidates cache', async () => {
    const app = await makeApp();
    const fixture = await createFixture(app, 'archived-success');
    const now = new Date().toISOString();
    testDatabase.transaction(() => {
      testDatabase
        .prepare(
          `UPDATE collect_fields
SET status = 'deprecated', updated_at = ?
WHERE project_id = ? AND field_key = 'event_name'`,
        )
        .run(now, fixture.projectId);
      testDatabase
        .prepare(
          `UPDATE collect_fields
SET status = 'dropped', updated_at = ?
WHERE project_id = ? AND field_key = 'is_success'`,
        )
        .run(now, fixture.projectId);
      testDatabase
        .prepare(
          `INSERT INTO collect_fields
  (project_id, field_key, label, type, required, description, status, renamed_to,
   schema_version, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fixture.projectId,
          'old_event_name',
          'Old event name',
          'string',
          0,
          '',
          'renamed',
          'event_name_v2',
          2,
          now,
          now,
        );
    });
    overwriteStatus(fixture.projectId, 'archived');
    expect(metadataCount('collect_fields', fixture.projectId)).toBe(3);
    await tables.getDefinition(fixture.projectId);
    expect(metadataCache.has(fixture.projectId)).toBe(true);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/tables/${fixture.projectId}`,
      headers: authorization(app, 'super_admin'),
      payload: { confirm: fixture.displayName },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ projectId: fixture.projectId, deleted: true });
    expect(response.json()).not.toHaveProperty('physicalName');
    expect(response.json()).not.toHaveProperty('ingestSecret');
    expect(await physicalTableRows(fixture.physicalName)).toEqual([]);
    expect(metadataCount('collect_tables', fixture.projectId)).toBe(0);
    expect(metadataCount('collect_fields', fixture.projectId)).toBe(0);
    expect(metadataCache.has(fixture.projectId)).toBe(false);
    await expect(tables.getDefinition(fixture.projectId)).resolves.toBeNull();
  });

  it('allows a failed table to be deleted without archiving it first', async () => {
    const app = await makeApp();
    const fixture = await createFixture(app, 'failed-success');
    overwriteStatus(fixture.projectId, 'failed');

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/tables/${fixture.projectId}`,
      headers: authorization(app, 'super_admin'),
      payload: { confirm: fixture.displayName },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(await physicalTableRows(fixture.physicalName)).toEqual([]);
    expect(metadataCount('collect_tables', fixture.projectId)).toBe(0);
    expect(metadataCount('collect_fields', fixture.projectId)).toBe(0);
  });

  it('idempotently finishes SQLite cleanup when the physical table was already dropped', async () => {
    const app = await makeApp();
    const fixture = await createFixture(app, 'partial-delete-retry');
    overwriteStatus(fixture.projectId, 'archived');
    await dropPhysicalTable(fixture.physicalName);
    expect(await physicalTableRows(fixture.physicalName)).toEqual([]);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/tables/${fixture.projectId}`,
      headers: authorization(app, 'super_admin'),
      payload: { confirm: fixture.displayName },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(metadataCount('collect_tables', fixture.projectId)).toBe(0);
    expect(metadataCount('collect_fields', fixture.projectId)).toBe(0);
  });
});
