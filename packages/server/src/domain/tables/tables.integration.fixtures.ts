import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';

import { buildApp } from '../../app.js';
import { bootstrapSchema } from '../../bootstrap/schema.js';
import { assertIdentifier, metaClient } from '../../infra/clickhouse.js';
import { serial } from '../../infra/serial.js';
import { openSqliteDatabase } from '../../infra/sqlite.js';
import type { UserRole } from '../users/types.js';
import { TableMetadataCache } from './cache.js';
import { TableRepository } from './repository.js';

interface TableCleanupRow {
  project_id: string;
  physical_name: string;
}

export function tablesIntegrationFixtures() {
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

  async function makeAppWithLogs(): Promise<{
    app: FastifyInstance;
    logs: Record<string, unknown>[];
  }> {
    const logs: Record<string, unknown>[] = [];
    const app = await buildApp({
      tableRepository: tables,
      logStream: {
        write(line) {
          logs.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    });
    apps.push(app);
    return { app, logs };
  }

  function authorization(app: FastifyInstance, role: UserRole): { authorization: string } {
    const token = app.jwt.sign({ username: operator(role), role });
    return { authorization: `Bearer ${token}` };
  }

  function createPayload(label: string, includeV4Types = false) {
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
        ...(includeV4Types
          ? [
              {
                key: 'channel',
                label: 'Channel',
                type: 'enum' as const,
                required: false,
                description: '',
                options: [
                  { value: 'web', label: 'Web', status: 'active' as const },
                  { value: 'app', label: 'App', status: 'disabled' as const },
                ],
              },
              {
                key: 'retry_count',
                label: 'Retry count',
                type: 'integer' as const,
                required: false,
                description: '',
              },
              {
                key: 'score',
                label: 'Score',
                type: 'float' as const,
                required: false,
                description: '',
              },
              {
                key: 'registered_at',
                label: 'Registered at',
                type: 'datetime' as const,
                required: false,
                description: '',
              },
            ]
          : []),
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
    includeV4Types = false,
  ): Promise<{ projectId: string; ingestSecret: string }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/tables',
      headers: authorization(app, role),
      payload: createPayload(label, includeV4Types),
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

  return {
    namespace,
    testDatabase,
    tables,
    operator,
    makeApp,
    makeAppWithLogs,
    authorization,
    createPayload,
    createTable,
  };
}
