import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { metaClient } from '../infra/clickhouse.js';
import { physicalTypeFor } from '../domain/tables/schema.js';
import {
  apps,
  createFixture,
  createLogger,
  dropColumn,
  dropTable,
  overwriteTableStatus,
  reconcile,
  systemColumns,
  tables,
} from './reconcile.integration.fixtures.js';

describe('startup reconcile against independent SQLite and ClickHouse', () => {
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
