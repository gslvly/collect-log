import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { bootstrapSchema } from '../../bootstrap/schema.js';
import { assertIdentifier, ingestClient, metaClient } from '../../infra/clickhouse.js';
import { openSqliteDatabase, type SqliteDatabase } from '../../infra/sqlite.js';
import { TableMetadataCache } from '../tables/cache.js';
import { TableRepository } from '../tables/repository.js';
import type { TableStatus } from '../tables/types.js';
import type { UserRole } from '../users/types.js';
import { formatOccurredAt } from '../ingest/writer.js';

interface QueryFixture {
  app: FastifyInstance;
  database: SqliteDatabase;
  dataDir: string;
  tables: TableRepository;
  projectId: string;
  physicalName: string;
  recordIds: string[];
  occurredAt: number[];
}

const fixtures: QueryFixture[] = [];
const baseTime = Date.parse('2026-08-27T15:58:00.123Z');
const queryRange = {
  start: baseTime - 60_000,
  end: baseTime + 10 * 60_000,
};

function authorization(app: FastifyInstance, role: UserRole): { authorization: string } {
  const token = app.jwt.sign({ username: `stage-d-${role}`, role });
  return { authorization: `Bearer ${token}` };
}

async function createFixture(exportMaxRows?: number): Promise<QueryFixture> {
  const dataDir = mkdtempSync(join(tmpdir(), 'collect-log-query-'));
  const database = openSqliteDatabase(dataDir);
  await bootstrapSchema(database);
  const tables = new TableRepository(database, new TableMetadataCache());
  const created = await tables.create(
    {
      displayName: `stage-d-${randomUUID()}`,
      description: 'stage D query fixture',
      fields: [
        {
          key: 'event_name',
          label: 'Event name',
          type: 'string',
          required: true,
          description: '',
        },
        {
          key: 'user_id',
          label: 'User ID',
          type: 'string',
          required: false,
          description: '',
        },
        {
          key: 'is_success',
          label: 'Success',
          type: 'boolean',
          required: false,
          description: '',
        },
        {
          key: 'note',
          label: 'Note',
          type: 'string',
          required: false,
          description: '',
        },
      ],
    },
    'stage-d-test',
  );
  const definition = await tables.getDefinition(created.table.projectId);
  if (definition === null) {
    throw new Error('Query fixture definition was not created');
  }

  const recordIds = Array.from({ length: 5 }, () => randomUUID());
  const occurredAt = Array.from({ length: 5 }, (_, index) => baseTime + index * 60_000);
  await ingestClient.insert({
    table: `data.${assertIdentifier(definition.physicalName)}`,
    values: [
      {
        _record_id: recordIds[0],
        _schema_version: definition.schemaVersion,
        _occurred_at: formatOccurredAt(occurredAt[0] ?? 0),
        event_name: 'login',
        user_id: 'u1',
        is_success: true,
        note: null,
      },
      {
        _record_id: recordIds[1],
        _schema_version: definition.schemaVersion,
        _occurred_at: formatOccurredAt(occurredAt[1] ?? 0),
        event_name: 'logout',
        user_id: 'u1',
        is_success: false,
        note: 'explicit note',
      },
      {
        _record_id: recordIds[2],
        _schema_version: definition.schemaVersion,
        _occurred_at: formatOccurredAt(occurredAt[2] ?? 0),
        event_name: 'login',
        user_id: 'u2',
        is_success: null,
        note: null,
      },
      {
        _record_id: recordIds[3],
        _schema_version: definition.schemaVersion,
        _occurred_at: formatOccurredAt(occurredAt[3] ?? 0),
        event_name: 'login',
        user_id: '',
        is_success: true,
        note: null,
      },
      {
        _record_id: recordIds[4],
        _schema_version: definition.schemaVersion,
        _occurred_at: formatOccurredAt(occurredAt[4] ?? 0),
        event_name: 'logout',
        user_id: null,
        is_success: null,
        note: null,
      },
    ],
    format: 'JSONEachRow',
    clickhouse_settings: {
      async_insert: 1,
      wait_for_async_insert: 1,
    },
  });

  const app = await buildApp({
    tableRepository: tables,
    ...(exportMaxRows === undefined
      ? {}
      : { queryRouteOptions: { exportLimits: { maxRows: exportMaxRows } } }),
  });
  const fixture = {
    app,
    database,
    dataDir,
    tables,
    projectId: definition.projectId,
    physicalName: definition.physicalName,
    recordIds,
    occurredAt,
  };
  fixtures.push(fixture);
  return fixture;
}

function setStatus(fixture: QueryFixture, status: TableStatus): void {
  fixture.database.transaction(() => {
    const result = fixture.database
      .prepare('UPDATE collect_tables SET status = ?, updated_at = ? WHERE project_id = ?')
      .run(status, new Date().toISOString(), fixture.projectId);
    if (result.changes !== 1) {
      throw new Error(`Fixture table ${fixture.projectId} was not found`);
    }
  });
  fixture.tables.clearCache();
}

async function query(
  fixture: QueryFixture,
  payload: Record<string, unknown>,
  role: UserRole = 'user',
) {
  return fixture.app.inject({
    method: 'POST',
    url: `/api/admin/tables/${fixture.projectId}/query`,
    headers: authorization(fixture.app, role),
    payload,
  });
}

async function statistics(
  fixture: QueryFixture,
  payload: Record<string, unknown>,
  role: UserRole = 'user',
) {
  return fixture.app.inject({
    method: 'POST',
    url: `/api/admin/tables/${fixture.projectId}/statistics`,
    headers: authorization(fixture.app, role),
    payload,
  });
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app.close();
    await metaClient.command({
      query: `DROP TABLE IF EXISTS data.${assertIdentifier(fixture.physicalName)} SYNC`,
    });
    fixture.database.close();
    rmSync(fixture.dataDir, { recursive: true, force: true });
  }
});

describe('stage D query routes against SQLite and ClickHouse', () => {
  it('returns precise nullable detail rows and paginates in both directions without gaps', async () => {
    const fixture = await createFixture();
    const headers = authorization(fixture.app, 'user');
    const allRows: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;

    do {
      const response = await query(fixture, {
        range: queryRange,
        limit: 2,
        order: 'asc',
        ...(cursor === null ? {} : { cursor }),
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as {
        rows: Array<Record<string, unknown>>;
        nextCursor: string | null;
        hasMore: boolean;
      };
      allRows.push(...body.rows);
      cursor = body.nextCursor;
      if (!body.hasMore) {
        expect(body.nextCursor).toBeNull();
      }
    } while (cursor !== null);

    expect(allRows).toHaveLength(5);
    expect(new Set(allRows.map((row) => row._record_id))).toEqual(new Set(fixture.recordIds));
    expect(new Set(allRows.map((row) => row._record_id)).size).toBe(5);
    expect(allRows[0]).toMatchObject({
      _record_id: fixture.recordIds[0],
      _occurred_at: new Date(fixture.occurredAt[0] ?? 0).toISOString(),
      event_name: 'login',
      user_id: 'u1',
      is_success: true,
      note: null,
    });
    expect(allRows[0]).not.toHaveProperty('physical_name');

    const ascending = await query(fixture, { range: queryRange, limit: 5, order: 'asc' });
    const descending = await query(fixture, { range: queryRange, limit: 5, order: 'desc' });
    expect(ascending.json().rows[0]._record_id).toBe(fixture.recordIds[0]);
    expect(descending.json().rows[0]._record_id).toBe(fixture.recordIds[4]);

    const combinedFilter = await query(fixture, {
      range: queryRange,
      filter: {
        op: 'and',
        conditions: [
          { field: 'event_name', op: 'contains', value: 'login' },
          { field: 'is_success', op: 'eq', value: true },
        ],
      },
    });
    expect(combinedFilter.statusCode, combinedFilter.body).toBe(200);
    expect(
      combinedFilter.json().rows.map((row: Record<string, unknown>) => row._record_id),
    ).toEqual([fixture.recordIds[3], fixture.recordIds[0]]);

    const nullableNegativeFilter = await query(fixture, {
      range: queryRange,
      order: 'asc',
      filter: { field: 'user_id', op: 'neq', value: 'u1' },
    });
    expect(nullableNegativeFilter.statusCode, nullableNegativeFilter.body).toBe(200);
    expect(
      nullableNegativeFilter.json().rows.map((row: Record<string, unknown>) => row.user_id),
    ).toEqual(['u2', '', null]);

    const firstPage = await query(fixture, { range: queryRange, limit: 2 });
    const mismatched = await fixture.app.inject({
      method: 'POST',
      url: `/api/admin/tables/${fixture.projectId}/query`,
      headers,
      payload: {
        range: queryRange,
        limit: 2,
        cursor: firstPage.json().nextCursor,
        filter: { field: 'event_name', op: 'eq', value: 'login' },
      },
    });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });
  });

  it('executes all five metrics and changes day buckets with the requested time zone', async () => {
    const fixture = await createFixture();

    const total = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      metric: 'total',
    });
    expect(total.statusCode, total.body).toBe(200);
    expect(total.json()).toEqual({ metric: 'total', count: 5 });

    const utcTrend = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      metric: 'trend',
      granularity: 'day',
    });
    const shanghaiTrend = await statistics(fixture, {
      range: queryRange,
      tz: 'Asia/Shanghai',
      metric: 'trend',
      granularity: 'day',
    });
    expect(utcTrend.statusCode, utcTrend.body).toBe(200);
    expect(shanghaiTrend.statusCode, shanghaiTrend.body).toBe(200);
    expect(utcTrend.json().buckets).toEqual([{ bucket: '2026-08-27T00:00:00.000Z', count: 5 }]);
    expect(shanghaiTrend.json().buckets).toEqual([
      { bucket: '2026-08-26T16:00:00.000Z', count: 2 },
      { bucket: '2026-08-27T16:00:00.000Z', count: 3 },
    ]);

    const unique = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      metric: 'unique',
      field: 'user_id',
    });
    expect(unique.statusCode, unique.body).toBe(200);
    expect(unique.json()).toEqual({ metric: 'unique', field: 'user_id', count: 2 });

    const group = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      metric: 'group',
      field: 'user_id',
    });
    expect(group.statusCode, group.body).toBe(200);
    expect(group.json()).toEqual({
      metric: 'group',
      field: 'user_id',
      groups: [
        { value: 'u1', total: 2 },
        { value: '', total: 1 },
        { value: 'u2', total: 1 },
      ],
    });

    const ratio = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      metric: 'boolean_ratio',
      field: 'is_success',
    });
    expect(ratio.statusCode, ratio.body).toBe(200);
    expect(ratio.json()).toEqual({
      metric: 'boolean_ratio',
      field: 'is_success',
      trueCount: 2,
      falseCount: 1,
      nullCount: 2,
      total: 5,
    });
  });

  it('streams CSVWithNames and marks an injected one-row truncation', async () => {
    const full = await createFixture();
    const fullResponse = await full.app.inject({
      method: 'POST',
      url: `/api/admin/tables/${full.projectId}/export`,
      headers: {
        ...authorization(full.app, 'user'),
        origin: 'https://console.example.test',
      },
      payload: { range: queryRange, order: 'asc' },
    });
    expect(fullResponse.statusCode, fullResponse.body).toBe(200);
    expect(fullResponse.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(fullResponse.headers['access-control-expose-headers']).toBe(
      'Content-Disposition, X-Export-Truncated, X-Request-Id',
    );
    expect(fullResponse.headers['content-disposition']).toMatch(
      new RegExp(`^attachment; filename="collect_${full.projectId}_\\d{14}\\.csv"$`),
    );
    const fullLines = fullResponse.body.trimEnd().split('\n');
    expect(fullLines[0]).toContain('_record_id');
    expect(fullLines[0]).toContain('event_name');
    expect(fullLines).toHaveLength(6);

    const truncated = await createFixture(1);
    const truncatedResponse = await truncated.app.inject({
      method: 'POST',
      url: `/api/admin/tables/${truncated.projectId}/export`,
      headers: authorization(truncated.app, 'user'),
      payload: { range: queryRange },
    });
    expect(truncatedResponse.statusCode, truncatedResponse.body).toBe(200);
    expect(truncatedResponse.headers['x-export-truncated']).toBe('1');
    const truncatedLines = truncatedResponse.body.trimEnd().split('\n');
    expect(truncatedLines).toHaveLength(3);
    expect(truncatedLines.at(-1)).toBe('# truncated: exported 1 of 5 rows');
  });

  it('enforces table states and route roles while keeping archived data queryable', async () => {
    const fixture = await createFixture();
    const queryPayload = { range: queryRange };

    for (const status of ['creating', 'failed'] as const) {
      setStatus(fixture, status);
      const response = await query(fixture, queryPayload);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'TABLE_NOT_READY' } });
    }

    setStatus(fixture, 'archived');
    const archivedQuery = await query(fixture, queryPayload);
    expect(archivedQuery.statusCode, archivedQuery.body).toBe(200);
    const rowCount = await fixture.app.inject({
      method: 'GET',
      url: `/api/admin/tables/${fixture.projectId}/row-count`,
      headers: authorization(fixture.app, 'admin'),
    });
    expect(rowCount.statusCode, rowCount.body).toBe(200);
    expect(rowCount.json()).toEqual({ count: 5 });

    const userStatistics = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      metric: 'total',
    });
    const userExport = await fixture.app.inject({
      method: 'POST',
      url: `/api/admin/tables/${fixture.projectId}/export`,
      headers: authorization(fixture.app, 'user'),
      payload: queryPayload,
    });
    const forbiddenCount = await fixture.app.inject({
      method: 'GET',
      url: `/api/admin/tables/${fixture.projectId}/row-count`,
      headers: authorization(fixture.app, 'user'),
    });
    expect(userStatistics.statusCode, userStatistics.body).toBe(200);
    expect(userExport.statusCode, userExport.body).toBe(200);
    expect(forbiddenCount.statusCode).toBe(403);
    expect(forbiddenCount.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

    const unauthenticatedRequests = await Promise.all([
      fixture.app.inject({
        method: 'POST',
        url: `/api/admin/tables/${fixture.projectId}/query`,
        payload: queryPayload,
      }),
      fixture.app.inject({
        method: 'POST',
        url: `/api/admin/tables/${fixture.projectId}/statistics`,
        payload: { ...queryPayload, tz: 'UTC', metric: 'total' },
      }),
      fixture.app.inject({
        method: 'POST',
        url: `/api/admin/tables/${fixture.projectId}/export`,
        payload: queryPayload,
      }),
      fixture.app.inject({
        method: 'GET',
        url: `/api/admin/tables/${fixture.projectId}/row-count`,
      }),
    ]);
    for (const response of unauthenticatedRequests) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    }
  });
});
