import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach } from 'vitest';

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
  logs: Record<string, unknown>[];
}

const fixtures: QueryFixture[] = [];
export const baseTime = Date.parse('2026-08-27T15:58:00.123Z');
export const queryRange = {
  start: baseTime - 60_000,
  end: baseTime + 10 * 60_000,
};

export function authorization(app: FastifyInstance, role: UserRole): { authorization: string } {
  const token = app.jwt.sign({ username: `stage-d-${role}`, role });
  return { authorization: `Bearer ${token}` };
}

export async function createFixture(
  exportMaxRows?: number,
  includeFloat = false,
): Promise<QueryFixture> {
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
        ...(includeFloat
          ? [
              {
                key: 'score',
                label: 'Score',
                type: 'float' as const,
                required: false,
                description: '',
              },
              {
                key: 'safe_integer',
                label: 'Safe integer',
                type: 'integer' as const,
                required: false,
                description: '',
              },
              {
                key: 'business_at',
                label: 'Business time',
                type: 'datetime' as const,
                required: false,
                description: '',
              },
            ]
          : []),
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
        ...(includeFloat
          ? {
              score: 10,
              safe_integer: 9_007_199_254_740_000,
              business_at: formatOccurredAt(baseTime - 4_000),
            }
          : {}),
      },
      {
        _record_id: recordIds[1],
        _schema_version: definition.schemaVersion,
        _occurred_at: formatOccurredAt(occurredAt[1] ?? 0),
        event_name: 'logout',
        user_id: 'u1',
        is_success: false,
        note: 'explicit note',
        ...(includeFloat
          ? {
              score: 20,
              safe_integer: 2,
              business_at: formatOccurredAt(baseTime - 3_000),
            }
          : {}),
      },
      {
        _record_id: recordIds[2],
        _schema_version: definition.schemaVersion,
        _occurred_at: formatOccurredAt(occurredAt[2] ?? 0),
        event_name: 'login',
        user_id: 'u2',
        is_success: null,
        note: null,
        ...(includeFloat
          ? {
              score: null,
              safe_integer: null,
              business_at: null,
            }
          : {}),
      },
      {
        _record_id: recordIds[3],
        _schema_version: definition.schemaVersion,
        _occurred_at: formatOccurredAt(occurredAt[3] ?? 0),
        event_name: 'login',
        user_id: '',
        is_success: true,
        note: null,
        ...(includeFloat
          ? {
              score: 0,
              safe_integer: 0,
              business_at: formatOccurredAt(baseTime - 1_000),
            }
          : {}),
      },
      {
        _record_id: recordIds[4],
        _schema_version: definition.schemaVersion,
        _occurred_at: formatOccurredAt(occurredAt[4] ?? 0),
        event_name: 'logout',
        user_id: null,
        is_success: null,
        note: null,
        ...(includeFloat
          ? {
              score: 30,
              safe_integer: -5,
              business_at: formatOccurredAt(baseTime),
            }
          : {}),
      },
    ],
    format: 'JSONEachRow',
    clickhouse_settings: {
      async_insert: 1,
      wait_for_async_insert: 1,
    },
  });

  const logs: Record<string, unknown>[] = [];
  const app = await buildApp({
    tableRepository: tables,
    logStream: {
      write(line) {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
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
    logs,
  };
  fixtures.push(fixture);
  return fixture;
}

export function setStatus(fixture: QueryFixture, status: TableStatus): void {
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

export async function query(
  fixture: QueryFixture,
  payload: Record<string, unknown>,
  role: UserRole = 'user',
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  return fixture.app.inject({
    method: 'POST',
    url: `/api/admin/tables/${fixture.projectId}/query`,
    headers: authorization(fixture.app, role),
    payload,
  });
}

export async function statistics(
  fixture: QueryFixture,
  payload: Record<string, unknown>,
  role: UserRole = 'user',
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
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
