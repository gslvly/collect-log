import { randomBytes } from 'node:crypto';

import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';

import { metaClient, parameterizedQuery } from '../../infra/clickhouse.js';
import { tablesIntegrationFixtures } from './tables.integration.fixtures.js';

interface SystemColumnRow {
  name: string;
  type: string;
}

const {
  namespace,
  testDatabase,
  tables,
  operator,
  makeApp,
  authorization,
  createPayload,
  createTable,
} = tablesIntegrationFixtures();

describe('stage A-1 collection table acceptance against SQLite and ClickHouse', () => {
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
