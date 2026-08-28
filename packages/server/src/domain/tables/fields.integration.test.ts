import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { bootstrapSchema } from '../../bootstrap/schema.js';
import {
  assertIdentifier,
  ingestClient,
  metaClient,
  parameterizedQuery,
  readonlyClient,
} from '../../infra/clickhouse.js';
import { serial } from '../../infra/serial.js';
import { openSqliteDatabase } from '../../infra/sqlite.js';
import type { UserRole } from '../users/types.js';
import { TableMetadataCache } from './cache.js';
import { TableRepository } from './repository.js';

interface TableCleanupRow {
  project_id: string;
  physical_name: string;
}

interface FieldMetadataRow {
  field_key: string;
  label: string;
  type: string;
  required: number;
  description: string;
  status: string;
  renamed_to: string;
  schema_version: number;
}

interface SystemColumnRow {
  name: string;
  type: string;
}

const namespace = `stagea2_${randomUUID().replaceAll('-', '')}_`;
const testDataDir = mkdtempSync(join(tmpdir(), 'collect-log-fields-'));
const testDatabase = openSqliteDatabase(testDataDir);
const metadataCache = new TableMetadataCache();
const tables = new TableRepository(testDatabase, metadataCache);
const apps: FastifyInstance[] = [];

function operator(role: UserRole): string {
  return `${namespace}${role}`;
}

async function makeApp(): Promise<FastifyInstance> {
  const app = await buildApp({ tableRepository: tables });
  apps.push(app);
  return app;
}

function authorization(app: FastifyInstance, role: UserRole): { authorization: string } {
  const token = app.jwt.sign({ username: operator(role), role });
  return { authorization: `Bearer ${token}` };
}

function createPayload(label: string) {
  return {
    displayName: `${namespace}${label}`,
    description: `field integration fixture ${label}`,
    fields: [
      {
        key: 'event_name',
        label: 'Event name',
        type: 'string',
        required: true,
        description: 'Original event name',
      },
      {
        key: 'is_success',
        label: 'Success',
        type: 'boolean',
        required: false,
        description: 'Whether the event succeeded',
      },
    ],
  } as const;
}

function fieldPayload(key: string) {
  return {
    key,
    label: `${key} label`,
    type: 'string',
    required: false,
    description: `${key} description`,
  } as const;
}

async function cleanupTables(): Promise<void> {
  tables.clearCache();
  const rows = testDatabase
    .prepare<TableCleanupRow>(
      `SELECT project_id, physical_name
FROM collect_tables
WHERE created_by LIKE ?`,
    )
    .all(`${namespace}%`);
  if (rows.length === 0) {
    return;
  }

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

async function createTable(
  app: FastifyInstance,
  label: string,
): Promise<{ projectId: string; physicalName: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/tables',
    headers: authorization(app, 'admin'),
    payload: createPayload(label),
  });
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json() as Record<string, unknown>;
  expect(body).not.toHaveProperty(['table', 'Id'].join(''));
  expect(body).not.toHaveProperty('physicalName');
  const projectId = body.projectId as string;
  const table = await tables.findById(projectId);
  if (table === null) {
    throw new Error(`Created table ${projectId} was not persisted`);
  }
  return { projectId, physicalName: table.physicalName };
}

function fieldMetadata(projectId: string, fieldKey: string): FieldMetadataRow | undefined {
  return testDatabase
    .prepare<FieldMetadataRow>(
      `SELECT field_key, label, type, required, description, status,
       renamed_to, schema_version
FROM collect_fields
WHERE project_id = ? AND field_key = ?`,
    )
    .get(projectId, fieldKey);
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

async function insertRows(
  physicalName: string,
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  await ingestClient.insert({
    table: `data.${assertIdentifier(physicalName)}`,
    values: rows,
    format: 'JSONEachRow',
  });
}

function baseRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    _record_id: randomUUID(),
    _schema_version: 1,
    _occurred_at: '2026-08-27 08:00:00.000',
    event_name: null,
    is_success: null,
    ...overrides,
  };
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

describe('stage A-2 field changes against SQLite and ClickHouse', () => {
  it('adds a typed physical column and applies the exact update version rules', async () => {
    const app = await makeApp();
    const { projectId, physicalName } = await createTable(app, 'add-update');
    const headers = authorization(app, 'admin');

    await tables.getDefinition(projectId);
    expect(metadataCache.has(projectId)).toBe(true);
    const added = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields`,
      headers,
      payload: fieldPayload('country_code'),
    });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json()).toMatchObject({
      table: { schemaVersion: 2 },
      field: { key: 'country_code', type: 'string', status: 'active', schemaVersion: 2 },
    });
    expect(metadataCache.has(projectId)).toBe(false);
    await expect(systemColumns(physicalName, ['country_code'])).resolves.toEqual([
      { name: 'country_code', type: 'Nullable(String)' },
    ]);

    const detailAfterAdd = await app.inject({
      method: 'GET',
      url: `/api/admin/tables/${projectId}`,
      headers,
    });
    expect(detailAfterAdd.json()).toMatchObject({ table: { schemaVersion: 2 } });
    expect(detailAfterAdd.json().fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'country_code' })]),
    );

    const metadataOnly = await app.inject({
      method: 'PATCH',
      url: `/api/admin/tables/${projectId}/fields/country_code`,
      headers,
      payload: { label: 'Country code', description: 'ISO country code' },
    });
    expect(metadataOnly.statusCode, metadataOnly.body).toBe(200);
    expect(metadataOnly.json()).toMatchObject({ table: { schemaVersion: 2 } });
    expect(metadataCache.has(projectId)).toBe(false);
    expect(fieldMetadata(projectId, 'country_code')).toMatchObject({
      label: 'Country code',
      description: 'ISO country code',
      required: 0,
      schema_version: 2,
    });

    await tables.getDefinition(projectId);
    expect(metadataCache.has(projectId)).toBe(true);
    const required = await app.inject({
      method: 'PATCH',
      url: `/api/admin/tables/${projectId}/fields/country_code`,
      headers,
      payload: { required: true },
    });
    expect(required.statusCode, required.body).toBe(200);
    expect(required.json()).toMatchObject({
      table: { schemaVersion: 3 },
      field: { required: true, schemaVersion: 3 },
    });
    expect(metadataCache.has(projectId)).toBe(false);
    expect(fieldMetadata(projectId, 'country_code')).toMatchObject({
      required: 1,
      schema_version: 3,
    });

    const originalFieldMetadataOnly = await app.inject({
      method: 'PATCH',
      url: `/api/admin/tables/${projectId}/fields/event_name`,
      headers,
      payload: { label: 'Renamed label only' },
    });
    expect(originalFieldMetadataOnly.statusCode, originalFieldMetadataOnly.body).toBe(200);
    expect(originalFieldMetadataOnly.json()).toMatchObject({ table: { schemaVersion: 3 } });
    expect(fieldMetadata(projectId, 'event_name')).toMatchObject({
      label: 'Renamed label only',
      schema_version: 1,
    });
  });

  it('renames a column without losing data and keeps a traceable tombstone', async () => {
    const app = await makeApp();
    const { projectId, physicalName } = await createTable(app, 'rename');
    const headers = authorization(app, 'super_admin');
    await insertRows(physicalName, [
      baseRow({ event_name: 'checkout', is_success: true }),
      baseRow({ event_name: 'login', is_success: false }),
      baseRow({ event_name: 'signup', is_success: true }),
    ]);

    await tables.getDefinition(projectId);
    const renamed = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields/event_name/rename`,
      headers,
      payload: { key: 'event_kind' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({
      table: { schemaVersion: 2 },
      field: {
        key: 'event_kind',
        label: 'Event name',
        type: 'string',
        required: true,
        description: 'Original event name',
        status: 'active',
        schemaVersion: 2,
      },
      message: '前端上报代码需同步改用新 Key，否则旧 Key 的上报会被拒绝',
    });
    expect(metadataCache.has(projectId)).toBe(false);

    const values = await parameterizedQuery<{ event_kind: string }>({
      client: readonlyClient,
      query: `SELECT event_kind
FROM data.${assertIdentifier(physicalName)}
ORDER BY event_kind`,
      params: {},
    });
    expect(values).toEqual([
      { event_kind: 'checkout' },
      { event_kind: 'login' },
      { event_kind: 'signup' },
    ]);
    expect(await systemColumns(physicalName, ['event_kind', 'event_name'])).toEqual([
      { name: 'event_kind', type: 'Nullable(String)' },
    ]);
    expect(fieldMetadata(projectId, 'event_name')).toMatchObject({
      status: 'renamed',
      renamed_to: 'event_kind',
      schema_version: 2,
    });
    expect(fieldMetadata(projectId, 'event_kind')).toMatchObject({
      label: 'Event name',
      type: 'string',
      required: 1,
      description: 'Original event name',
      status: 'active',
      renamed_to: '',
      schema_version: 2,
    });

    // 改名后的旧 Key 可以重新建：墓碑只是记号，删掉它不碰任何物理列，
    // 老数据仍然跟着 event_kind 走，新的 event_name 是一列全新的空列。
    const reused = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields`,
      headers,
      payload: fieldPayload('event_name'),
    });
    expect(reused.statusCode, reused.body).toBe(200);
    expect(reused.json()).toMatchObject({
      table: { schemaVersion: 3 },
      field: { key: 'event_name', status: 'active', schemaVersion: 3 },
    });
    expect(fieldMetadata(projectId, 'event_name')).toMatchObject({
      status: 'active',
      renamed_to: '',
      schema_version: 3,
    });
    expect(await systemColumns(physicalName, ['event_kind', 'event_name'])).toEqual([
      { name: 'event_kind', type: 'Nullable(String)' },
      { name: 'event_name', type: 'Nullable(String)' },
    ]);
    const afterReuse = await parameterizedQuery<{ event_kind: string; event_name: string | null }>({
      client: readonlyClient,
      query: `SELECT event_kind, event_name
FROM data.${assertIdentifier(physicalName)}
ORDER BY event_kind`,
      params: {},
    });
    expect(afterReuse).toEqual([
      { event_kind: 'checkout', event_name: null },
      { event_kind: 'login', event_name: null },
      { event_kind: 'signup', event_name: null },
    ]);
  });

  // DESIGN 7.3：RENAME COLUMN 没有 IF EXISTS。DDL 成功后 SQLite 侧中断的话，
  // 重试必须能收尾，否则数据就卡在只有物理列认得的新名字上。
  it('finishes an interrupted rename whose physical column was already renamed', async () => {
    const app = await makeApp();
    const { projectId, physicalName } = await createTable(app, 'rename-resume');
    const headers = authorization(app, 'admin');
    await insertRows(physicalName, [baseRow({ event_name: 'checkout', is_success: true })]);

    await serial(async () => {
      await metaClient.command({
        query: `ALTER TABLE data.${assertIdentifier(physicalName)}
RENAME COLUMN \`event_name\` TO \`event_kind\``,
      });
    });

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields/event_name/rename`,
      headers,
      payload: { key: 'event_kind' },
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json()).toMatchObject({
      table: { schemaVersion: 2 },
      field: { key: 'event_kind', status: 'active', schemaVersion: 2 },
    });
    expect(fieldMetadata(projectId, 'event_name')).toMatchObject({
      status: 'renamed',
      renamed_to: 'event_kind',
    });
    expect(fieldMetadata(projectId, 'event_kind')).toMatchObject({
      status: 'active',
      renamed_to: '',
    });
    expect(await systemColumns(physicalName, ['event_kind', 'event_name'])).toEqual([
      { name: 'event_kind', type: 'Nullable(String)' },
    ]);
    const rows = await parameterizedQuery<{ event_kind: string | null }>({
      client: readonlyClient,
      query: `SELECT event_kind
FROM data.${assertIdentifier(physicalName)}`,
      params: {},
    });
    expect(rows).toEqual([{ event_kind: 'checkout' }]);
  });

  it('soft-deprecates without touching the physical column or its data', async () => {
    const app = await makeApp();
    const { projectId, physicalName } = await createTable(app, 'deprecate');
    const headers = authorization(app, 'admin');
    await insertRows(physicalName, [
      baseRow({ event_name: 'a', is_success: true }),
      baseRow({ event_name: 'b', is_success: null }),
      baseRow({ event_name: 'c', is_success: false }),
    ]);

    const usageBefore = await app.inject({
      method: 'GET',
      url: `/api/admin/tables/${projectId}/fields/is_success/usage`,
      headers,
    });
    expect(usageBefore.statusCode, usageBefore.body).toBe(200);
    expect(usageBefore.json()).toEqual({ count: 2 });

    await tables.getDefinition(projectId);
    expect(metadataCache.has(projectId)).toBe(true);
    const deprecated = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields/is_success/deprecate`,
      headers,
    });
    expect(deprecated.statusCode, deprecated.body).toBe(200);
    expect(deprecated.json()).toMatchObject({
      table: { schemaVersion: 2 },
      field: { status: 'deprecated', schemaVersion: 2 },
    });
    expect(metadataCache.has(projectId)).toBe(false);
    expect(fieldMetadata(projectId, 'is_success')).toMatchObject({
      status: 'deprecated',
      schema_version: 2,
    });
    expect(await systemColumns(physicalName, ['is_success'])).toEqual([
      { name: 'is_success', type: 'Nullable(Bool)' },
    ]);

    const usageAfter = await app.inject({
      method: 'GET',
      url: `/api/admin/tables/${projectId}/fields/is_success/usage`,
      headers,
    });
    expect(usageAfter.statusCode, usageAfter.body).toBe(200);
    expect(usageAfter.json()).toEqual({ count: 2 });

    const unavailable = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: `/api/admin/tables/${projectId}/fields/is_success`,
        headers,
        payload: { label: 'No longer mutable' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields/is_success/rename`,
        headers,
        payload: { key: 'event_outcome' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields/is_success/deprecate`,
        headers,
      }),
      app.inject({
        method: 'DELETE',
        url: `/api/admin/tables/${projectId}/fields/is_success`,
        headers,
        payload: { confirm: 'is_success' },
      }),
    ]);
    for (const response of unavailable) {
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'FIELD_NOT_FOUND' } });
    }

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/admin/tables/${projectId}/fields/missing_field`,
      headers,
      payload: { label: 'Missing' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'FIELD_NOT_FOUND' } });
  });

  it('physically drops a confirmed field but retains its dropped tombstone', async () => {
    const app = await makeApp();
    const { projectId, physicalName } = await createTable(app, 'drop');
    const headers = authorization(app, 'super_admin');
    await insertRows(physicalName, [baseRow({ event_name: 'sensitive', is_success: true })]);

    for (const payload of [undefined, { confirm: 'wrong-key' }]) {
      const rejected = await app.inject({
        method: 'DELETE',
        url: `/api/admin/tables/${projectId}/fields/event_name`,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED' } });
    }

    await tables.getDefinition(projectId);
    expect(metadataCache.has(projectId)).toBe(true);
    const dropped = await app.inject({
      method: 'DELETE',
      url: `/api/admin/tables/${projectId}/fields/event_name`,
      headers,
      payload: { confirm: 'event_name' },
    });
    expect(dropped.statusCode, dropped.body).toBe(200);
    expect(dropped.json()).toMatchObject({
      table: { schemaVersion: 2 },
      field: { key: 'event_name', status: 'dropped', schemaVersion: 2 },
    });
    expect(metadataCache.has(projectId)).toBe(false);
    expect(await systemColumns(physicalName, ['event_name'])).toEqual([]);
    expect(fieldMetadata(projectId, 'event_name')).toMatchObject({
      field_key: 'event_name',
      status: 'dropped',
      schema_version: 2,
    });

    const usage = await app.inject({
      method: 'GET',
      url: `/api/admin/tables/${projectId}/fields/event_name/usage`,
      headers,
    });
    expect(usage.statusCode).toBe(404);
    expect(usage.json()).toMatchObject({ error: { code: 'FIELD_NOT_FOUND' } });

    // 删除后同名重建：清掉墓碑再 ADD，建出的是一列全新的空列，
    // 原来那列的数据在 DROP 时就已经没了，这里不会再动任何物理数据。
    const reused = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields`,
      headers,
      payload: fieldPayload('event_name'),
    });
    expect(reused.statusCode, reused.body).toBe(200);
    expect(reused.json()).toMatchObject({
      table: { schemaVersion: 3 },
      field: { key: 'event_name', status: 'active', schemaVersion: 3 },
    });
    expect(fieldMetadata(projectId, 'event_name')).toMatchObject({
      status: 'active',
      renamed_to: '',
      schema_version: 3,
    });
    expect(await systemColumns(physicalName, ['event_name'])).toEqual([
      { name: 'event_name', type: 'Nullable(String)' },
    ]);
    const afterReuse = await parameterizedQuery<{ event_name: string | null }>({
      client: readonlyClient,
      query: `SELECT event_name
FROM data.${assertIdentifier(physicalName)}`,
      params: {},
    });
    expect(afterReuse).toEqual([{ event_name: null }]);
  });

  it('serializes concurrent additions so both fields land with consecutive versions', async () => {
    const app = await makeApp();
    const { projectId, physicalName } = await createTable(app, 'concurrent-add');
    const headers = authorization(app, 'admin');
    const add = (fieldKey: string) =>
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields`,
        headers,
        payload: fieldPayload(fieldKey),
      });

    const responses = await Promise.all([add('concurrent_a'), add('concurrent_b')]);
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(200);
    }
    expect(
      responses.map((response) => response.json().table.schemaVersion as number).sort(),
    ).toEqual([2, 3]);
    await expect(tables.findById(projectId)).resolves.toMatchObject({ schemaVersion: 3 });
    expect(await systemColumns(physicalName, ['concurrent_a', 'concurrent_b'])).toEqual([
      { name: 'concurrent_a', type: 'Nullable(String)' },
      { name: 'concurrent_b', type: 'Nullable(String)' },
    ]);
    expect(fieldMetadata(projectId, 'concurrent_a')).toMatchObject({ status: 'active' });
    expect(fieldMetadata(projectId, 'concurrent_b')).toMatchObject({ status: 'active' });
  });

  it('rejects field changes unless the table is active or disabled', async () => {
    const app = await makeApp();
    const { projectId } = await createTable(app, 'table-state');
    const headers = authorization(app, 'admin');
    const updateStatus = testDatabase.prepare(`UPDATE collect_tables
SET status = ?, updated_at = ?
WHERE project_id = ?`);

    for (const status of ['creating', 'failed', 'archived'] as const) {
      updateStatus.run(status, new Date().toISOString(), projectId);
      const rejected = await app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields`,
        headers,
        payload: fieldPayload(`state_${status}`),
      });
      expect(rejected.statusCode, rejected.body).toBe(409);
      expect(rejected.json()).toMatchObject({ error: { code: 'TABLE_STATE_CONFLICT' } });
    }

    updateStatus.run('disabled', new Date().toISOString(), projectId);
    const allowed = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields`,
      headers,
      payload: fieldPayload('disabled_table_field'),
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  it('denies the user role on every DESIGN 15.4 field route', async () => {
    const app = await makeApp();
    const { projectId } = await createTable(app, 'permissions');
    const headers = authorization(app, 'user');
    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields`,
        headers,
        payload: fieldPayload('forbidden_field'),
      }),
      app.inject({
        method: 'PATCH',
        url: `/api/admin/tables/${projectId}/fields/event_name`,
        headers,
        payload: { label: 'Forbidden' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields/event_name/rename`,
        headers,
        payload: { key: 'forbidden_name' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields/event_name/deprecate`,
        headers,
      }),
      app.inject({
        method: 'DELETE',
        url: `/api/admin/tables/${projectId}/fields/event_name`,
        headers,
        payload: { confirm: 'event_name' },
      }),
      app.inject({
        method: 'GET',
        url: `/api/admin/tables/${projectId}/fields/event_name/usage`,
        headers,
      }),
    ]);

    expect(responses).toHaveLength(6);
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
  });

  it('rejects malformed field keys with INVALID_FIELD_KEY on every entry point', async () => {
    const app = await makeApp();
    const { projectId } = await createTable(app, 'invalid-key');
    const headers = authorization(app, 'admin');

    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/admin/tables',
        headers,
        payload: { ...createPayload('invalid-key-create'), fields: [fieldPayload('Bad-Key')] },
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields`,
        headers,
        payload: fieldPayload('Bad-Key'),
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields/event_name/rename`,
        headers,
        payload: { key: '_private' },
      }),
      app.inject({
        method: 'PATCH',
        url: `/api/admin/tables/${projectId}/fields/Bad-Key`,
        headers,
        payload: { label: 'whatever' },
      }),
      app.inject({
        method: 'GET',
        url: `/api/admin/tables/${projectId}/fields/Bad-Key/usage`,
        headers,
      }),
    ]);

    expect(responses).toHaveLength(5);
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_FIELD_KEY' } });
    }
  });
});
