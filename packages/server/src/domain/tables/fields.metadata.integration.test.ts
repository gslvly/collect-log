import { describe, expect, it } from 'vitest';

import {
  assertIdentifier,
  metaClient,
  parameterizedQuery,
  readonlyClient,
} from '../../infra/clickhouse.js';
import { serial } from '../../infra/serial.js';
import {
  authorization,
  baseRow,
  createTable,
  fieldMetadata,
  fieldPayload,
  insertRows,
  makeApp,
  metadataCache,
  systemColumns,
  tables,
} from './fields.integration.fixtures.js';

describe('stage A-2 field changes against SQLite and ClickHouse', () => {
  it('adds a typed physical column and applies the exact update version rules', async () => {
    const app = await makeApp();
    const { projectId, physicalName } = await createTable(app, 'add-update');
    const headers = authorization(app, 'admin');

    await tables.getDefinition(projectId);
    expect(metadataCache.has(projectId)).toBe(true);
    const added = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields`,
      headers,
      payload: fieldPayload('country_code'),
    });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json()).toMatchObject({
      table: { schemaVersion: 2 },
      field: { key: 'country_code', type: 'string', status: 'active', schemaVersion: 2 },
    });
    expect(metadataCache.has(projectId)).toBe(false);
    await expect(systemColumns(physicalName, ['country_code'])).resolves.toEqual([
      { name: 'country_code', type: 'Nullable(String)' },
    ]);

    const detailAfterAdd = await app.inject({
      method: 'GET',
      url: `/api/admin/tables/${projectId}`,
      headers,
    });
    expect(detailAfterAdd.json()).toMatchObject({ table: { schemaVersion: 2 } });
    expect(detailAfterAdd.json().fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'country_code' })]),
    );

    const metadataOnly = await app.inject({
      method: 'PATCH',
      url: `/api/admin/tables/${projectId}/fields/country_code`,
      headers,
      payload: { label: 'Country code', description: 'ISO country code' },
    });
    expect(metadataOnly.statusCode, metadataOnly.body).toBe(200);
    expect(metadataOnly.json()).toMatchObject({ table: { schemaVersion: 2 } });
    expect(metadataCache.has(projectId)).toBe(false);
    expect(fieldMetadata(projectId, 'country_code')).toMatchObject({
      label: 'Country code',
      description: 'ISO country code',
      required: 0,
      schema_version: 2,
    });

    await tables.getDefinition(projectId);
    expect(metadataCache.has(projectId)).toBe(true);
    const required = await app.inject({
      method: 'PATCH',
      url: `/api/admin/tables/${projectId}/fields/country_code`,
      headers,
      payload: { required: true },
    });
    expect(required.statusCode, required.body).toBe(200);
    expect(required.json()).toMatchObject({
      table: { schemaVersion: 3 },
      field: { required: true, schemaVersion: 3 },
    });
    expect(metadataCache.has(projectId)).toBe(false);
    expect(fieldMetadata(projectId, 'country_code')).toMatchObject({
      required: 1,
      schema_version: 3,
    });

    const originalFieldMetadataOnly = await app.inject({
      method: 'PATCH',
      url: `/api/admin/tables/${projectId}/fields/event_name`,
      headers,
      payload: { label: 'Renamed label only' },
    });
    expect(originalFieldMetadataOnly.statusCode, originalFieldMetadataOnly.body).toBe(200);
    expect(originalFieldMetadataOnly.json()).toMatchObject({ table: { schemaVersion: 3 } });
    expect(fieldMetadata(projectId, 'event_name')).toMatchObject({
      label: 'Renamed label only',
      schema_version: 1,
    });
  });

  it('renames a column without losing data and keeps a traceable tombstone', async () => {
    const app = await makeApp();
    const { projectId, physicalName } = await createTable(app, 'rename');
    const headers = authorization(app, 'super_admin');
    await insertRows(physicalName, [
      baseRow({ event_name: 'checkout', is_success: true }),
      baseRow({ event_name: 'login', is_success: false }),
      baseRow({ event_name: 'signup', is_success: true }),
    ]);

    await tables.getDefinition(projectId);
    const renamed = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields/event_name/rename`,
      headers,
      payload: { key: 'event_kind' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({
      table: { schemaVersion: 2 },
      field: {
        key: 'event_kind',
        label: 'Event name',
        type: 'string',
        required: true,
        description: 'Original event name',
        status: 'active',
        schemaVersion: 2,
      },
      message: '前端上报代码需同步改用新 Key，否则旧 Key 的上报会被拒绝',
    });
    expect(metadataCache.has(projectId)).toBe(false);

    const values = await parameterizedQuery<{ event_kind: string }>({
      client: readonlyClient,
      query: `SELECT event_kind
FROM data.${assertIdentifier(physicalName)}
ORDER BY event_kind`,
      params: {},
    });
    expect(values).toEqual([
      { event_kind: 'checkout' },
      { event_kind: 'login' },
      { event_kind: 'signup' },
    ]);
    expect(await systemColumns(physicalName, ['event_kind', 'event_name'])).toEqual([
      { name: 'event_kind', type: 'Nullable(String)' },
    ]);
    expect(fieldMetadata(projectId, 'event_name')).toMatchObject({
      status: 'renamed',
      renamed_to: 'event_kind',
      schema_version: 2,
    });
    expect(fieldMetadata(projectId, 'event_kind')).toMatchObject({
      label: 'Event name',
      type: 'string',
      required: 1,
      description: 'Original event name',
      status: 'active',
      renamed_to: '',
      schema_version: 2,
    });

    // 改名后的旧 Key 可以重新建：墓碑只是记号，删掉它不碰任何物理列，
    // 老数据仍然跟着 event_kind 走，新的 event_name 是一列全新的空列。
    const reused = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields`,
      headers,
      payload: fieldPayload('event_name'),
    });
    expect(reused.statusCode, reused.body).toBe(200);
    expect(reused.json()).toMatchObject({
      table: { schemaVersion: 3 },
      field: { key: 'event_name', status: 'active', schemaVersion: 3 },
    });
    expect(fieldMetadata(projectId, 'event_name')).toMatchObject({
      status: 'active',
      renamed_to: '',
      schema_version: 3,
    });
    expect(await systemColumns(physicalName, ['event_kind', 'event_name'])).toEqual([
      { name: 'event_kind', type: 'Nullable(String)' },
      { name: 'event_name', type: 'Nullable(String)' },
    ]);
    const afterReuse = await parameterizedQuery<{ event_kind: string; event_name: string | null }>({
      client: readonlyClient,
      query: `SELECT event_kind, event_name
FROM data.${assertIdentifier(physicalName)}
ORDER BY event_kind`,
      params: {},
    });
    expect(afterReuse).toEqual([
      { event_kind: 'checkout', event_name: null },
      { event_kind: 'login', event_name: null },
      { event_kind: 'signup', event_name: null },
    ]);
  });

  // DESIGN 7.3：RENAME COLUMN 没有 IF EXISTS。DDL 成功后 SQLite 侧中断的话，
  // 重试必须能收尾，否则数据就卡在只有物理列认得的新名字上。
  it('finishes an interrupted rename whose physical column was already renamed', async () => {
    const app = await makeApp();
    const { projectId, physicalName } = await createTable(app, 'rename-resume');
    const headers = authorization(app, 'admin');
    await insertRows(physicalName, [baseRow({ event_name: 'checkout', is_success: true })]);

    await serial(async () => {
      await metaClient.command({
        query: `ALTER TABLE data.${assertIdentifier(physicalName)}
RENAME COLUMN \`event_name\` TO \`event_kind\``,
      });
    });

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields/event_name/rename`,
      headers,
      payload: { key: 'event_kind' },
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json()).toMatchObject({
      table: { schemaVersion: 2 },
      field: { key: 'event_kind', status: 'active', schemaVersion: 2 },
    });
    expect(fieldMetadata(projectId, 'event_name')).toMatchObject({
      status: 'renamed',
      renamed_to: 'event_kind',
    });
    expect(fieldMetadata(projectId, 'event_kind')).toMatchObject({
      status: 'active',
      renamed_to: '',
    });
    expect(await systemColumns(physicalName, ['event_kind', 'event_name'])).toEqual([
      { name: 'event_kind', type: 'Nullable(String)' },
    ]);
    const rows = await parameterizedQuery<{ event_kind: string | null }>({
      client: readonlyClient,
      query: `SELECT event_kind
FROM data.${assertIdentifier(physicalName)}`,
      params: {},
    });
    expect(rows).toEqual([{ event_kind: 'checkout' }]);
  });
});
