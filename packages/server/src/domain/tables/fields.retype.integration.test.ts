import { describe, expect, it } from 'vitest';

import { assertIdentifier, parameterizedQuery, readonlyClient } from '../../infra/clickhouse.js';
import {
  authorization,
  baseRow,
  createTable,
  insertRows,
  makeApp,
  metadataCache,
  systemColumns,
  tables,
  testDatabase,
} from './fields.integration.fixtures.js';

describe('stage A-2 field changes against SQLite and ClickHouse', () => {
  it('converts string and enum in both directions without changing stored values', async () => {
    const app = await makeApp();
    const { projectId, physicalName } = await createTable(app, 'retype-string-enum');
    const headers = authorization(app, 'admin');
    await insertRows(physicalName, [
      baseRow({ event_name: 'checkout', is_success: true }),
      baseRow({ event_name: 'login', is_success: false }),
    ]);

    await tables.getDefinition(projectId);
    const toEnum = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields/event_name/retype`,
      headers,
      payload: {
        type: 'enum',
        options: [
          { value: 'checkout', label: 'Checkout' },
          { value: 'login', label: 'Login', status: 'disabled' },
        ],
      },
    });
    expect(toEnum.statusCode, toEnum.body).toBe(200);
    expect(toEnum.json()).toMatchObject({
      table: { schemaVersion: 2 },
      field: {
        key: 'event_name',
        type: 'enum',
        schemaVersion: 2,
        options: [
          { value: 'checkout', label: 'Checkout', status: 'active' },
          { value: 'login', label: 'Login', status: 'disabled' },
        ],
      },
    });
    expect(toEnum.json().message).toContain('历史数据中不在选项内的值仍可查询与分组');
    expect(metadataCache.has(projectId)).toBe(false);
    expect(await systemColumns(physicalName, ['event_name'])).toEqual([
      { name: 'event_name', type: 'LowCardinality(Nullable(String))' },
    ]);
    const afterToEnum = await parameterizedQuery<{ event_name: string }>({
      client: readonlyClient,
      query: `SELECT event_name
FROM data.${assertIdentifier(physicalName)}
ORDER BY event_name`,
      params: {},
    });
    expect(afterToEnum).toEqual([{ event_name: 'checkout' }, { event_name: 'login' }]);

    const stringWithOptions = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields/event_name/retype`,
      headers,
      payload: { type: 'string', options: [] },
    });
    expect(stringWithOptions.statusCode, stringWithOptions.body).toBe(400);
    expect(stringWithOptions.json()).toMatchObject({
      error: { code: 'INVALID_FIELD_VALUE' },
    });

    const toString = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields/event_name/retype`,
      headers,
      payload: { type: 'string' },
    });
    expect(toString.statusCode, toString.body).toBe(200);
    expect(toString.json()).toMatchObject({
      table: { schemaVersion: 3 },
      field: { key: 'event_name', type: 'string', options: [], schemaVersion: 3 },
    });
    expect(await systemColumns(physicalName, ['event_name'])).toEqual([
      { name: 'event_name', type: 'Nullable(String)' },
    ]);
    const afterToString = await parameterizedQuery<{ event_name: string }>({
      client: readonlyClient,
      query: `SELECT event_name
FROM data.${assertIdentifier(physicalName)}
ORDER BY event_name`,
      params: {},
    });
    expect(afterToString).toEqual([{ event_name: 'checkout' }, { event_name: 'login' }]);
    expect(
      testDatabase
        .prepare<{ count: number }>(
          `SELECT count(*) AS count
FROM collect_field_options
WHERE project_id = ? AND field_key = ?`,
        )
        .get(projectId, 'event_name'),
    ).toEqual({ count: 0 });
  });

  it('rejects unsupported or malformed retypes before changing the physical column', async () => {
    const app = await makeApp();
    const { projectId, physicalName } = await createTable(app, 'invalid-retype');
    const headers = authorization(app, 'admin');

    const unsupported = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields/event_name/retype`,
      headers,
      payload: { type: 'boolean' },
    });
    expect(unsupported.statusCode, unsupported.body).toBe(400);
    expect(unsupported.json()).toMatchObject({ error: { code: 'INVALID_FIELD_TYPE' } });

    const noActiveOption = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields/event_name/retype`,
      headers,
      payload: {
        type: 'enum',
        options: [{ value: 'legacy', label: 'Legacy', status: 'disabled' }],
      },
    });
    expect(noActiveOption.statusCode, noActiveOption.body).toBe(400);
    expect(noActiveOption.json()).toMatchObject({ error: { code: 'INVALID_FIELD_VALUE' } });
    expect(await systemColumns(physicalName, ['event_name'])).toEqual([
      { name: 'event_name', type: 'Nullable(String)' },
    ]);
    await expect(tables.findById(projectId)).resolves.toMatchObject({ schemaVersion: 1 });
  });
});
