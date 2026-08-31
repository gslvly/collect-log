import { describe, expect, it, vi } from 'vitest';

import {
  createFixture,
  dropTable,
  metadataCache,
  overwriteTableStatus,
  reconcile,
  tables,
} from './reconcile.integration.fixtures.js';

describe('startup reconcile against independent SQLite and ClickHouse', () => {
  it('promotes a creating table when its physical table exists', async () => {
    const fixture = await createFixture('creating-existing');
    overwriteTableStatus(fixture.projectId, 'creating');
    await tables.getDefinition(fixture.projectId);
    expect(metadataCache.has(fixture.projectId)).toBe(true);

    const result = await reconcile();

    await expect(tables.findById(fixture.projectId)).resolves.toMatchObject({ status: 'active' });
    expect(metadataCache.has(fixture.projectId)).toBe(false);
    expect(result).toMatchObject({ fixed: 1, failed: 0 });
  });

  it('marks a creating table failed when its physical table is absent', async () => {
    const fixture = await createFixture('creating-missing');
    await dropTable(fixture.physicalName);
    overwriteTableStatus(fixture.projectId, 'creating');

    const result = await reconcile();

    await expect(tables.findById(fixture.projectId)).resolves.toMatchObject({ status: 'failed' });
    expect(result).toMatchObject({ fixed: 1, failed: 0 });
  });

  it('promotes a failed table through the legal creating intermediate state', async () => {
    const fixture = await createFixture('failed-existing');
    overwriteTableStatus(fixture.projectId, 'failed');
    const setStatus = vi.spyOn(tables, 'setStatus');

    const result = await reconcile();

    expect(setStatus.mock.calls).toEqual([
      [fixture.projectId, 'creating'],
      [fixture.projectId, 'active'],
    ]);
    await expect(tables.findById(fixture.projectId)).resolves.toMatchObject({ status: 'active' });
    expect(result).toMatchObject({ fixed: 1, failed: 0 });
  });

  it('leaves a failed table without a physical table untouched', async () => {
    const fixture = await createFixture('failed-missing');
    await dropTable(fixture.physicalName);
    overwriteTableStatus(fixture.projectId, 'failed');
    const setStatus = vi.spyOn(tables, 'setStatus');

    const result = await reconcile();

    expect(setStatus).not.toHaveBeenCalled();
    await expect(tables.findById(fixture.projectId)).resolves.toMatchObject({ status: 'failed' });
    expect(result).toMatchObject({ fixed: 0, failed: 0 });
  });
});
