import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';

import { buildApp } from '../../app.js';
import { bootstrapSchema } from '../../bootstrap/schema.js';
import {
  assertIdentifier,
  ingestClient,
  metaClient,
  parameterizedQuery,
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
export const testDatabase = openSqliteDatabase(testDataDir);
export const metadataCache = new TableMetadataCache();
export const tables = new TableRepository(testDatabase, metadataCache);
const apps: FastifyInstance[] = [];

function operator(role: UserRole): string {
  return `${namespace}${role}`;
}

export async function makeApp(): Promise<FastifyInstance> {
  const app = await buildApp({ tableRepository: tables });
  apps.push(app);
  return app;
}

export function authorization(app: FastifyInstance, role: UserRole): { authorization: string } {
  const token = app.jwt.sign({ username: operator(role), role });
  return { authorization: `Bearer ${token}` };
}

export function createPayload(label: string) {
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

export function fieldPayload(key: string) {
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

export async function createTable(
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

export function fieldMetadata(projectId: string, fieldKey: string): FieldMetadataRow | undefined {
  return testDatabase
    .prepare<FieldMetadataRow>(
      `SELECT field_key, label, type, required, description, status,
       renamed_to, schema_version
FROM collect_fields
WHERE project_id = ? AND field_key = ?`,
    )
    .get(projectId, fieldKey);
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

export async function insertRows(
  physicalName: string,
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  await ingestClient.insert({
    table: `data.${assertIdentifier(physicalName)}`,
    values: rows,
    format: 'JSONEachRow',
  });
}

export function baseRow(overrides: Record<string, unknown>): Record<string, unknown> {
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
