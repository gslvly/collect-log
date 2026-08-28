import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { bootstrapSchema } from '../../bootstrap/schema.js';
import { assertIdentifier, metaClient } from '../../infra/clickhouse.js';
import { serial } from '../../infra/serial.js';
import { openSqliteDatabase } from '../../infra/sqlite.js';
import type { UserRole } from '../users/types.js';
import { TableMetadataCache } from './cache.js';
import { TableRepository } from './repository.js';
import type { FieldStatus, TableStatus } from './types.js';

interface TableCleanupRow {
  physical_name: string;
}

const namespace = `stageb2_template_${randomUUID().replaceAll('-', '')}`;
const testDataDir = mkdtempSync(join(tmpdir(), 'collect-log-table-template-'));
const testDatabase = openSqliteDatabase(testDataDir);
const tables = new TableRepository(testDatabase, new TableMetadataCache());
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
  fieldCount: number,
): Promise<{ projectId: string; displayName: string; description: string }> {
  const displayName = `${namespace}_${label}`;
  const description = `template fixture ${label}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/tables',
    headers: authorization(app, 'admin'),
    payload: {
      displayName,
      description,
      fields: Array.from({ length: fieldCount }, (_, index) => ({
        key: `field_${index}`,
        label: `Field ${index}`,
        type: index % 2 === 0 ? ('string' as const) : ('boolean' as const),
        required: index === 0,
        description: `Field ${index} description`,
      })),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { projectId: response.json().projectId as string, displayName, description };
}

function overwriteTable(projectId: string, status: TableStatus, createdAt: string): void {
  testDatabase.transaction(() => {
    const result = testDatabase
      .prepare(
        `UPDATE collect_tables
SET status = ?, created_at = ?, updated_at = ?
WHERE project_id = ?`,
      )
      .run(status, createdAt, createdAt, projectId);
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

describe('stage B-2 collection table templates', () => {
  it('lists every table status newest-first with active-field counts', async () => {
    const app = await makeApp();
    const active = await createFixture(app, 'active', 1);
    const disabled = await createFixture(app, 'disabled', 2);
    const creating = await createFixture(app, 'creating', 3);
    const failed = await createFixture(app, 'failed', 2);
    const archived = await createFixture(app, 'archived', 3);
    overwriteTable(active.projectId, 'active', '2026-08-27T00:00:01.000Z');
    overwriteTable(disabled.projectId, 'disabled', '2026-08-27T00:00:02.000Z');
    overwriteTable(creating.projectId, 'creating', '2026-08-27T00:00:03.000Z');
    overwriteTable(failed.projectId, 'failed', '2026-08-27T00:00:04.000Z');
    overwriteTable(archived.projectId, 'archived', '2026-08-27T00:00:05.000Z');
    overwriteFieldStatus(failed.projectId, 'field_1', 'dropped');
    overwriteFieldStatus(archived.projectId, 'field_0', 'deprecated');
    overwriteFieldStatus(archived.projectId, 'field_1', 'renamed');

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/tables/templates',
      headers: authorization(app, 'admin'),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      templates: [
        {
          projectId: archived.projectId,
          displayName: archived.displayName,
          status: 'archived',
          fieldCount: 1,
        },
        {
          projectId: failed.projectId,
          displayName: failed.displayName,
          status: 'failed',
          fieldCount: 1,
        },
        {
          projectId: creating.projectId,
          displayName: creating.displayName,
          status: 'creating',
          fieldCount: 3,
        },
        {
          projectId: disabled.projectId,
          displayName: disabled.displayName,
          status: 'disabled',
          fieldCount: 2,
        },
        {
          projectId: active.projectId,
          displayName: active.displayName,
          status: 'active',
          fieldCount: 1,
        },
      ],
    });
  });

  it('returns only active editable fields and strips every forbidden metadata key', async () => {
    const app = await makeApp();
    const fixture = await createFixture(app, 'detail', 3);
    overwriteFieldStatus(fixture.projectId, 'field_0', 'deprecated');
    overwriteFieldStatus(fixture.projectId, 'field_1', 'dropped');

    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/tables/${fixture.projectId}/template`,
      headers: authorization(app, 'super_admin'),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      sourceDisplayName: fixture.displayName,
      description: fixture.description,
      fields: [
        {
          key: 'field_2',
          label: 'Field 2',
          type: 'string',
          required: false,
          description: 'Field 2 description',
        },
      ],
    });
    const serialized = JSON.stringify(response.json());
    for (const forbiddenKey of ['projectId', 'ingestSecret', 'status', 'schemaVersion']) {
      expect(serialized).not.toContain(`"${forbiddenKey}"`);
    }
  });

  it('denies user access to both template endpoints', async () => {
    const app = await makeApp();
    const fixture = await createFixture(app, 'user-forbidden', 1);
    const headers = authorization(app, 'user');

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/admin/tables/templates', headers }),
      app.inject({
        method: 'GET',
        url: `/api/admin/tables/${fixture.projectId}/template`,
        headers,
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
  });

  it('returns TABLE_NOT_FOUND for an unknown template source', async () => {
    const app = await makeApp();
    const projectId = `prj_${ulid()}`;

    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/tables/${projectId}/template`,
      headers: authorization(app, 'admin'),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'TABLE_NOT_FOUND' } });
  });

  it('keeps the static templates route ahead of the projectId parameter route', async () => {
    const app = await makeApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/tables/templates',
      headers: authorization(app, 'super_admin'),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ templates: [] });
    expect(response.body).not.toContain('INVALID_PROJECT_ID');
  });
});
