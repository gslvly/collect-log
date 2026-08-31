import { describe, expect, it } from 'vitest';

import { assertIdentifier, metaClient, parameterizedQuery } from '../infra/clickhouse.js';
import { physicalTypeFor } from '../domain/tables/schema.js';
import {
  addColumn,
  createFixture,
  createLogger,
  dropColumn,
  insertRow,
  metadataCache,
  modifyColumn,
  overwriteFieldStatus,
  reconcile,
  renameColumn,
  systemColumns,
  tables,
  testDatabase,
} from './reconcile.integration.fixtures.js';

describe('startup reconcile against independent SQLite and ClickHouse', () => {
  it('restores a missing active column with the metadata-derived physical type', async () => {
    const fixture = await createFixture('missing-active-column');
    await dropColumn(fixture.physicalName, 'is_success');
    await tables.getDefinition(fixture.projectId);
    expect(metadataCache.has(fixture.projectId)).toBe(true);

    const result = await reconcile();

    expect(await systemColumns(fixture.physicalName, ['is_success'])).toEqual([
      { name: 'is_success', type: physicalTypeFor('boolean') },
    ]);
    expect(metadataCache.has(fixture.projectId)).toBe(false);
    expect(result).toMatchObject({ fixed: 1, failed: 0 });
  });

  it('reconciles only the lossless String and LowCardinality(String) drift pair', async () => {
    const metadataString = await createFixture('drift-to-string');
    const metadataEnum = await createFixture('drift-to-enum');
    await modifyColumn(metadataString.physicalName, 'event_name', physicalTypeFor('enum'));
    testDatabase.transaction(() => {
      testDatabase
        .prepare(
          `UPDATE collect_fields
SET type = ?, updated_at = ?
WHERE project_id = ? AND field_key = ?`,
        )
        .run('enum', new Date().toISOString(), metadataEnum.projectId, 'event_name');
    });
    tables.clearCache();
    const { logger, entries } = createLogger();

    const result = await reconcile({ logger });

    expect(await systemColumns(metadataString.physicalName, ['event_name'])).toEqual([
      { name: 'event_name', type: physicalTypeFor('string') },
    ]);
    expect(await systemColumns(metadataEnum.physicalName, ['event_name'])).toEqual([
      { name: 'event_name', type: physicalTypeFor('enum') },
    ]);
    expect(
      entries.filter((entry) => entry.bindings.operation === 'reconcile_modify_column_type'),
    ).toHaveLength(2);
    expect(result).toMatchObject({ fixed: 2, failed: 0 });
  });

  it('warns without modifying a physical type mismatch outside the lossless pair', async () => {
    const fixture = await createFixture('unsafe-type-drift');
    await modifyColumn(fixture.physicalName, 'event_name', physicalTypeFor('boolean'));
    const { logger, entries } = createLogger();

    const result = await reconcile({ logger });

    expect(await systemColumns(fixture.physicalName, ['event_name'])).toEqual([
      { name: 'event_name', type: physicalTypeFor('boolean') },
    ]);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        bindings: expect.objectContaining({
          operation: 'reconcile_column_type_mismatch',
          projectId: fixture.projectId,
          fieldKey: 'event_name',
          metadataType: 'string',
          actualType: physicalTypeFor('boolean'),
          expectedType: physicalTypeFor('string'),
        }),
      }),
    );
    expect(result).toMatchObject({ fixed: 0, failed: 0 });
  });

  // DESIGN 7.3 的 rename 中间态：DDL 生效、SQLite 事务没提交。
  // 补空列会把数据永久留在孤儿列里，因此必须反向改回来。
  it('reverts an interrupted rename instead of adding an empty column', async () => {
    const fixture = await createFixture('interrupted-rename');
    await insertRow(fixture.physicalName, { event_name: 'checkout', is_success: true });
    await renameColumn(fixture.physicalName, 'event_name', 'event_kind');
    const { logger, entries } = createLogger();

    const result = await reconcile({ logger });

    expect(await systemColumns(fixture.physicalName, ['event_kind', 'event_name'])).toEqual([
      { name: 'event_name', type: physicalTypeFor('string') },
    ]);
    const rows = await parameterizedQuery<{ event_name: string | null }>({
      client: metaClient,
      query: `SELECT event_name
FROM data.${assertIdentifier(fixture.physicalName)}`,
      params: {},
    });
    expect(rows).toEqual([{ event_name: 'checkout' }]);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'info',
        bindings: expect.objectContaining({
          operation: 'reconcile_revert_rename',
          projectId: fixture.projectId,
          fieldKey: 'event_name',
          orphanColumn: 'event_kind',
        }),
      }),
    );
    expect(result).toMatchObject({ fixed: 1, failed: 0 });
  });

  it('does not mistake a differently typed orphan column for an interrupted rename', async () => {
    const fixture = await createFixture('orphan-type-mismatch');
    await dropColumn(fixture.physicalName, 'event_name');
    await addColumn(fixture.physicalName, 'event_kind', physicalTypeFor('boolean'));
    const { logger, entries } = createLogger();

    const result = await reconcile({ logger });

    expect(await systemColumns(fixture.physicalName, ['event_kind', 'event_name'])).toEqual([
      { name: 'event_kind', type: physicalTypeFor('boolean') },
      { name: 'event_name', type: physicalTypeFor('string') },
    ]);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        bindings: expect.objectContaining({
          operation: 'reconcile_unmanaged_column',
          fieldKey: 'event_kind',
        }),
      }),
    );
    expect(result).toMatchObject({ fixed: 1, failed: 0 });
  });

  it('warns but preserves a physical column with no metadata row', async () => {
    const fixture = await createFixture('unmanaged-column');
    await addColumn(fixture.physicalName, 'orphan_column');
    const { logger, entries } = createLogger();

    const result = await reconcile({ logger });

    expect(await systemColumns(fixture.physicalName, ['orphan_column'])).toEqual([
      { name: 'orphan_column', type: 'Nullable(String)' },
    ]);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        bindings: expect.objectContaining({
          operation: 'reconcile_unmanaged_column',
          projectId: fixture.projectId,
          physicalName: fixture.physicalName,
          fieldKey: 'orphan_column',
        }),
      }),
    );
    expect(result).toMatchObject({ fixed: 0, failed: 0 });
  });

  it('drops a physical column whose metadata is a dropped tombstone', async () => {
    const fixture = await createFixture('dropped-column');
    overwriteFieldStatus(fixture.projectId, 'event_name', 'dropped');
    await tables.getDefinition(fixture.projectId);
    expect(metadataCache.has(fixture.projectId)).toBe(true);

    const result = await reconcile();

    expect(await systemColumns(fixture.physicalName, ['event_name'])).toEqual([]);
    expect(metadataCache.has(fixture.projectId)).toBe(false);
    expect(result).toMatchObject({ fixed: 1, failed: 0 });
  });

  it('retains the physical column for deprecated metadata', async () => {
    const fixture = await createFixture('deprecated-column');
    overwriteFieldStatus(fixture.projectId, 'event_name', 'deprecated');

    const result = await reconcile();

    expect(await systemColumns(fixture.physicalName, ['event_name'])).toEqual([
      { name: 'event_name', type: physicalTypeFor('string') },
    ]);
    expect(result).toMatchObject({ fixed: 0, failed: 0 });
  });

  it('drops a stale physical column whose metadata is a renamed tombstone', async () => {
    const fixture = await createFixture('renamed-column');
    overwriteFieldStatus(fixture.projectId, 'event_name', 'renamed');

    const result = await reconcile();

    expect(await systemColumns(fixture.physicalName, ['event_name'])).toEqual([]);
    expect(result).toMatchObject({ fixed: 1, failed: 0 });
  });
});
