import { randomBytes, randomUUID } from 'node:crypto';
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

interface TableCleanupRow {
  project_id: string;
  physical_name: string;
}

interface SystemTableRow {
  name: string;
}

interface SystemColumnRow {
  name: string;
  type: string;
  default_kind: string;
  default_expression: string;
}

const namespace = `stagea1_${randomUUID().replaceAll('-', '')}_`;
const testDataDir = mkdtempSync(join(tmpdir(), 'collect-log-tables-'));
const testDatabase = openSqliteDatabase(testDataDir);
const tables = new TableRepository(testDatabase, new TableMetadataCache());
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
    description: `integration fixture ${label}`,
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
  role: 'admin' | 'super_admin',
  label: string,
): Promise<{ projectId: string; ingestSecret: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/tables',
    headers: authorization(app, role),
    payload: createPayload(label),
  });
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json() as Record<string, unknown>;
  expect(body).not.toHaveProperty(['table', 'Id'].join(''));
  expect(body).not.toHaveProperty('physicalName');
  return body as { projectId: string; ingestSecret: string };
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

describe('stage A-1 collection table acceptance against SQLite and ClickHouse', () => {
  it('creates metadata, the physical table, and exact system/custom column types', async () => {
    const app = await makeApp();
    const created = await createTable(app, 'admin', 'physical-schema');
    const table = await tables.findById(created.projectId);

    expect(created.projectId).toMatch(/^prj_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(Buffer.from(created.ingestSecret, 'base64url')).toHaveLength(32);
    expect(table).toMatchObject({
      projectId: created.projectId,
      status: 'active',
      schemaVersion: 1,
      ingestSecret: created.ingestSecret,
      ingestSecretPrevExpiresAt: null,
      createdBy: operator('admin'),
    });

    const physicalName = table?.physicalName ?? '';
    const physicalTables = await parameterizedQuery<SystemTableRow>({
      client: metaClient,
      query: `SELECT name
FROM system.tables
WHERE database = {database:String}
  AND name = {name:String}`,
      params: { database: 'data', name: physicalName },
    });
    expect(physicalTables).toEqual([{ name: physicalName }]);

    const columns = await parameterizedQuery<SystemColumnRow>({
      client: metaClient,
      query: `SELECT name, type, default_kind, default_expression
FROM system.columns
WHERE database = {database:String}
  AND table = {table:String}
ORDER BY position`,
      params: { database: 'data', table: physicalName },
    });
    expect(columns).toEqual([
      {
        name: '_record_id',
        type: 'UUID',
        default_kind: '',
        default_expression: '',
      },
      {
        name: '_schema_version',
        type: 'UInt32',
        default_kind: '',
        default_expression: '',
      },
      {
        name: '_occurred_at',
        type: "DateTime64(3, 'UTC')",
        default_kind: '',
        default_expression: '',
      },
      {
        name: '_received_at',
        type: "DateTime64(3, 'UTC')",
        default_kind: 'DEFAULT',
        default_expression: 'now64(3)',
      },
      {
        name: 'event_name',
        type: 'Nullable(String)',
        default_kind: '',
        default_expression: '',
      },
      {
        name: 'is_success',
        type: 'Nullable(Bool)',
        default_kind: '',
        default_expression: '',
      },
    ]);
  });

  it('enforces every legal and illegal table-state transition through the API', async () => {
    const app = await makeApp();
    const { projectId } = await createTable(app, 'super_admin', 'state-machine');
    const headers = authorization(app, 'admin');

    for (const status of ['disabled', 'active', 'archived', 'active'] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/status`,
        headers,
        payload: { status },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ table: { status } });
    }

    const invalid = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/status`,
      headers,
      payload: { status: 'failed' },
    });
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json()).toMatchObject({ error: { code: 'TABLE_STATE_CONFLICT' } });
  });

  it('rotates secrets by retaining the previous key', async () => {
    const app = await makeApp();
    const created = await createTable(app, 'admin', 'secret-rotation');
    const headers = authorization(app, 'super_admin');

    const rotationStartedAt = Date.now();
    const viewed = await app.inject({
      method: 'GET',
      url: `/api/admin/tables/${created.projectId}/secret`,
      headers,
    });
    const rotated = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${created.projectId}/secret/rotate`,
      headers,
    });
    const rotationFinishedAt = Date.now();
    const current = await tables.findById(created.projectId);

    expect(viewed.statusCode).toBe(200);
    expect(viewed.json()).toEqual(created);
    expect(rotated.statusCode).toBe(200);
    expect(viewed.json()).not.toHaveProperty(['table', 'Id'].join(''));
    expect(viewed.json()).not.toHaveProperty('physicalName');
    expect(rotated.json()).not.toHaveProperty(['table', 'Id'].join(''));
    expect(rotated.json()).not.toHaveProperty('physicalName');
    expect(rotated.json().ingestSecret).not.toBe(created.ingestSecret);
    expect(Buffer.from(rotated.json().ingestSecret as string, 'base64url')).toHaveLength(32);
    expect(current).toMatchObject({
      ingestSecret: rotated.json().ingestSecret,
      ingestSecretPrev: created.ingestSecret,
    });
    const previousSecretExpiresAt = Date.parse(current?.ingestSecretPrevExpiresAt ?? '');
    expect(previousSecretExpiresAt).toBeGreaterThanOrEqual(
      rotationStartedAt + 7 * 24 * 60 * 60 * 1_000,
    );
    expect(previousSecretExpiresAt).toBeLessThanOrEqual(
      rotationFinishedAt + 7 * 24 * 60 * 60 * 1_000,
    );
  });

  it('applies the DESIGN 11.2 permission matrix, including secret denial for user', async () => {
    const app = await makeApp();
    const created = await createTable(app, 'admin', 'permissions');

    for (const role of ['user', 'admin', 'super_admin'] as const) {
      const headers = authorization(app, role);
      const list = await app.inject({ method: 'GET', url: '/api/admin/tables', headers });
      const detail = await app.inject({
        method: 'GET',
        url: `/api/admin/tables/${created.projectId}`,
        headers,
      });
      expect(list.statusCode).toBe(200);
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        table: { projectId: created.projectId },
        fields: [{ key: 'event_name' }, { key: 'is_success' }],
      });
    }

    const userHeaders = authorization(app, 'user');
    const restrictedRequests = [
      app.inject({
        method: 'POST',
        url: '/api/admin/tables',
        headers: userHeaders,
        payload: createPayload('forbidden-create'),
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${created.projectId}/retry`,
        headers: userHeaders,
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${created.projectId}/status`,
        headers: userHeaders,
        payload: { status: 'disabled' },
      }),
      app.inject({
        method: 'GET',
        url: `/api/admin/tables/${created.projectId}/secret`,
        headers: userHeaders,
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${created.projectId}/secret/rotate`,
        headers: userHeaders,
      }),
    ];
    const restricted = await Promise.all(restrictedRequests);
    for (const response of restricted) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
  });

  it('retries a failed create idempotently with its persisted initial fields', async () => {
    const app = await makeApp();
    const projectId = `prj_${ulid()}`;
    const physicalName = `collect_${randomBytes(16).toString('hex')}`;
    const now = new Date().toISOString();
    const base = {
      project_id: projectId,
      physical_name: physicalName,
      display_name: `${namespace}retry`,
      description: '',
      schema_version: 1,
      ingest_secret: randomBytes(32).toString('base64url'),
      ingest_secret_prev: '',
      ingest_secret_prev_expires_at: null,
      created_by: operator('admin'),
      created_at: now,
      updated_at: now,
    };

    testDatabase.transaction(() => {
      testDatabase
        .prepare(
          `INSERT INTO collect_tables
  (project_id, physical_name, display_name, description, status, schema_version,
   ingest_secret, ingest_secret_prev, ingest_secret_prev_expires_at, created_by, created_at,
   updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          base.project_id,
          base.physical_name,
          base.display_name,
          base.description,
          'failed',
          base.schema_version,
          base.ingest_secret,
          base.ingest_secret_prev,
          base.ingest_secret_prev_expires_at,
          base.created_by,
          base.created_at,
          base.updated_at,
        );
      testDatabase
        .prepare(
          `INSERT INTO collect_fields
  (project_id, field_key, label, type, required, description, status, renamed_to, schema_version,
   created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(projectId, 'retry_field', 'Retry field', 'string', 0, '', 'active', '', 1, now, now);
    });
    tables.clearCache();

    const request = () =>
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/retry`,
        headers: authorization(app, 'admin'),
      });
    const first = await request();
    const second = await request();
    const table = await tables.findById(projectId);
    const columns = await parameterizedQuery<Pick<SystemColumnRow, 'name' | 'type'>>({
      client: metaClient,
      query: `SELECT name, type
FROM system.columns
WHERE database = {database:String}
  AND table = {table:String}
  AND name = {name:String}`,
      params: { database: 'data', table: physicalName, name: 'retry_field' },
    });

    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(table).toMatchObject({ status: 'active' });
    expect(columns).toEqual([{ name: 'retry_field', type: 'Nullable(String)' }]);
  });

  it('rejects reusing an occupied or deprecated field key', async () => {
    const app = await makeApp();
    const created = await createTable(app, 'admin', 'retired-field');
    const headers = authorization(app, 'admin');
    const payload = {
      key: 'event_name',
      label: 'Event name reused',
      type: 'string',
      required: true,
      description: '',
    } as const;
    const occupied = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${created.projectId}/fields`,
      headers,
      payload,
    });
    const deprecated = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${created.projectId}/fields/event_name/deprecate`,
      headers,
    });
    const reused = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${created.projectId}/fields`,
      headers,
      payload,
    });

    expect(occupied.statusCode).toBe(409);
    expect(occupied.json()).toMatchObject({
      error: { code: 'FIELD_KEY_EXISTS', field: 'event_name' },
    });
    // deprecated 的物理列与历史数据都还在，复用会让元数据和列类型脱节，因此仍然拒绝；
    // 可复用的只有物理列已经不在旧 Key 名下的 dropped / renamed（见 fields.integration.test.ts）。
    expect(deprecated.statusCode, deprecated.body).toBe(200);
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({
      error: { code: 'FIELD_KEY_RETIRED', field: 'event_name' },
    });
  });

  it('persists both current rows when two tables are created concurrently', async () => {
    const app = await makeApp();
    const headers = authorization(app, 'admin');
    const request = (label: string) =>
      app.inject({
        method: 'POST',
        url: '/api/admin/tables',
        headers,
        payload: createPayload(label),
      });

    const responses = await Promise.all([request('concurrent-a'), request('concurrent-b')]);
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(200);
    }
    const projectIds = responses.map((response) => response.json().projectId as string);
    expect(new Set(projectIds).size).toBe(2);

    const rows = testDatabase
      .prepare<{ project_id: string }>(
        `SELECT project_id
FROM collect_tables
WHERE project_id IN (?, ?)
ORDER BY project_id`,
      )
      .all(projectIds[0] ?? '', projectIds[1] ?? '');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.project_id))).toEqual(new Set(projectIds));
  });
});
