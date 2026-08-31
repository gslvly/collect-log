import { describe, expect, it } from 'vitest';

import { assertIdentifier, parameterizedQuery, readonlyClient } from '../../infra/clickhouse.js';
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
  it('soft-deprecates without touching the physical column or its data', async () => {
    const app = await makeApp();
    const { projectId, physicalName } = await createTable(app, 'deprecate');
    const headers = authorization(app, 'admin');
    await insertRows(physicalName, [
      baseRow({ event_name: 'a', is_success: true }),
      baseRow({ event_name: 'b', is_success: null }),
      baseRow({ event_name: 'c', is_success: false }),
    ]);

    const usageBefore = await app.inject({
      method: 'GET',
      url: `/api/admin/tables/${projectId}/fields/is_success/usage`,
      headers,
    });
    expect(usageBefore.statusCode, usageBefore.body).toBe(200);
    expect(usageBefore.json()).toEqual({ count: 2 });

    await tables.getDefinition(projectId);
    expect(metadataCache.has(projectId)).toBe(true);
    const deprecated = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields/is_success/deprecate`,
      headers,
    });
    expect(deprecated.statusCode, deprecated.body).toBe(200);
    expect(deprecated.json()).toMatchObject({
      table: { schemaVersion: 2 },
      field: { status: 'deprecated', schemaVersion: 2 },
    });
    expect(metadataCache.has(projectId)).toBe(false);
    expect(fieldMetadata(projectId, 'is_success')).toMatchObject({
      status: 'deprecated',
      schema_version: 2,
    });
    expect(await systemColumns(physicalName, ['is_success'])).toEqual([
      { name: 'is_success', type: 'Nullable(Bool)' },
    ]);

    const activeDefinition = await tables.getDefinition(projectId);
    expect(activeDefinition).not.toBeNull();
    if (activeDefinition === null) {
      throw new Error(`Table ${projectId} disappeared while checking its active definition`);
    }
    expect(activeDefinition.fields.some((field) => field.key === 'is_success')).toBe(false);
    const detailAfterDeprecate = await app.inject({
      method: 'GET',
      url: `/api/admin/tables/${projectId}`,
      headers,
    });
    expect(detailAfterDeprecate.statusCode, detailAfterDeprecate.body).toBe(200);
    expect(detailAfterDeprecate.json().fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'is_success',
          label: 'Success',
          type: 'boolean',
          required: false,
          description: 'Whether the event succeeded',
          status: 'deprecated',
          renamedTo: '',
          schemaVersion: 2,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        }),
      ]),
    );

    const usageAfter = await app.inject({
      method: 'GET',
      url: `/api/admin/tables/${projectId}/fields/is_success/usage`,
      headers,
    });
    expect(usageAfter.statusCode, usageAfter.body).toBe(200);
    expect(usageAfter.json()).toEqual({ count: 2 });

    const unavailable = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: `/api/admin/tables/${projectId}/fields/is_success`,
        headers,
        payload: { label: 'No longer mutable' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields/is_success/rename`,
        headers,
        payload: { key: 'event_outcome' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields/is_success/deprecate`,
        headers,
      }),
      app.inject({
        method: 'PUT',
        url: `/api/admin/tables/${projectId}/fields/is_success/options`,
        headers,
        payload: { options: [{ value: 'yes', label: 'Yes' }] },
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields/is_success/retype`,
        headers,
        payload: { type: 'string' },
      }),
    ]);
    for (const response of unavailable) {
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'FIELD_NOT_FOUND' } });
    }

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/admin/tables/${projectId}/fields/missing_field`,
      headers,
      payload: { label: 'Missing' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'FIELD_NOT_FOUND' } });
  });

  it('physically drops a deprecated field and allows rebuilding the key with a new type', async () => {
    const app = await makeApp();
    const { projectId, physicalName } = await createTable(app, 'drop-deprecated');
    const headers = authorization(app, 'admin');
    await insertRows(physicalName, [
      baseRow({ event_name: 'login', is_success: true }),
      baseRow({ event_name: 'logout', is_success: false }),
    ]);

    const deprecated = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields/is_success/deprecate`,
      headers,
    });
    expect(deprecated.statusCode, deprecated.body).toBe(200);
    expect(deprecated.json()).toMatchObject({
      table: { schemaVersion: 2 },
      field: { key: 'is_success', status: 'deprecated', schemaVersion: 2 },
    });

    await tables.getDefinition(projectId);
    expect(metadataCache.has(projectId)).toBe(true);
    const dropped = await app.inject({
      method: 'DELETE',
      url: `/api/admin/tables/${projectId}/fields/is_success`,
      headers,
      payload: { confirm: 'is_success' },
    });
    expect(dropped.statusCode, dropped.body).toBe(200);
    expect(dropped.json()).toMatchObject({
      table: { schemaVersion: 3 },
      field: { key: 'is_success', status: 'dropped', schemaVersion: 3 },
    });
    expect(metadataCache.has(projectId)).toBe(false);
    expect(await systemColumns(physicalName, ['is_success'])).toEqual([]);
    expect(fieldMetadata(projectId, 'is_success')).toMatchObject({
      field_key: 'is_success',
      type: 'boolean',
      status: 'dropped',
      schema_version: 3,
    });

    const rebuilt = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields`,
      headers,
      payload: fieldPayload('is_success'),
    });
    expect(rebuilt.statusCode, rebuilt.body).toBe(200);
    expect(rebuilt.json()).toMatchObject({
      table: { schemaVersion: 4 },
      field: { key: 'is_success', type: 'string', status: 'active', schemaVersion: 4 },
    });
    expect(await systemColumns(physicalName, ['is_success'])).toEqual([
      { name: 'is_success', type: 'Nullable(String)' },
    ]);
    expect(fieldMetadata(projectId, 'is_success')).toMatchObject({
      type: 'string',
      status: 'active',
      schema_version: 4,
    });
    const rebuiltValues = await parameterizedQuery<{ is_success: string | null }>({
      client: readonlyClient,
      query: `SELECT is_success
FROM data.${assertIdentifier(physicalName)}`,
      params: {},
    });
    expect(rebuiltValues).toEqual([{ is_success: null }, { is_success: null }]);
  });

  it('physically drops a confirmed field but retains its dropped tombstone', async () => {
    const app = await makeApp();
    const { projectId, physicalName } = await createTable(app, 'drop');
    const headers = authorization(app, 'super_admin');
    await insertRows(physicalName, [baseRow({ event_name: 'sensitive', is_success: true })]);

    for (const payload of [undefined, { confirm: 'wrong-key' }]) {
      const rejected = await app.inject({
        method: 'DELETE',
        url: `/api/admin/tables/${projectId}/fields/event_name`,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED' } });
    }

    await tables.getDefinition(projectId);
    expect(metadataCache.has(projectId)).toBe(true);
    const dropped = await app.inject({
      method: 'DELETE',
      url: `/api/admin/tables/${projectId}/fields/event_name`,
      headers,
      payload: { confirm: 'event_name' },
    });
    expect(dropped.statusCode, dropped.body).toBe(200);
    expect(dropped.json()).toMatchObject({
      table: { schemaVersion: 2 },
      field: { key: 'event_name', status: 'dropped', schemaVersion: 2 },
    });
    expect(metadataCache.has(projectId)).toBe(false);
    expect(await systemColumns(physicalName, ['event_name'])).toEqual([]);
    expect(fieldMetadata(projectId, 'event_name')).toMatchObject({
      field_key: 'event_name',
      status: 'dropped',
      schema_version: 2,
    });

    const usage = await app.inject({
      method: 'GET',
      url: `/api/admin/tables/${projectId}/fields/event_name/usage`,
      headers,
    });
    expect(usage.statusCode).toBe(404);
    expect(usage.json()).toMatchObject({ error: { code: 'FIELD_NOT_FOUND' } });

    // 删除后同名重建：清掉墓碑再 ADD，建出的是一列全新的空列，
    // 原来那列的数据在 DROP 时就已经没了，这里不会再动任何物理数据。
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
    expect(await systemColumns(physicalName, ['event_name'])).toEqual([
      { name: 'event_name', type: 'Nullable(String)' },
    ]);
    const afterReuse = await parameterizedQuery<{ event_name: string | null }>({
      client: readonlyClient,
      query: `SELECT event_name
FROM data.${assertIdentifier(physicalName)}`,
      params: {},
    });
    expect(afterReuse).toEqual([{ event_name: null }]);
  });
});
