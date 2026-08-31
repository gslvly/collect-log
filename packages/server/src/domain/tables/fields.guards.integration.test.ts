import { describe, expect, it } from 'vitest';

import {
  authorization,
  createPayload,
  createTable,
  fieldMetadata,
  fieldPayload,
  makeApp,
  systemColumns,
  tables,
  testDatabase,
} from './fields.integration.fixtures.js';

describe('stage A-2 field changes against SQLite and ClickHouse', () => {
  it('serializes concurrent additions so both fields land with consecutive versions', async () => {
    const app = await makeApp();
    const { projectId, physicalName } = await createTable(app, 'concurrent-add');
    const headers = authorization(app, 'admin');
    const add = (fieldKey: string) =>
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields`,
        headers,
        payload: fieldPayload(fieldKey),
      });

    const responses = await Promise.all([add('concurrent_a'), add('concurrent_b')]);
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(200);
    }
    expect(
      responses.map((response) => response.json().table.schemaVersion as number).sort(),
    ).toEqual([2, 3]);
    await expect(tables.findById(projectId)).resolves.toMatchObject({ schemaVersion: 3 });
    expect(await systemColumns(physicalName, ['concurrent_a', 'concurrent_b'])).toEqual([
      { name: 'concurrent_a', type: 'Nullable(String)' },
      { name: 'concurrent_b', type: 'Nullable(String)' },
    ]);
    expect(fieldMetadata(projectId, 'concurrent_a')).toMatchObject({ status: 'active' });
    expect(fieldMetadata(projectId, 'concurrent_b')).toMatchObject({ status: 'active' });
  });

  it('rejects field changes unless the table is active or disabled', async () => {
    const app = await makeApp();
    const { projectId } = await createTable(app, 'table-state');
    const headers = authorization(app, 'admin');
    const updateStatus = testDatabase.prepare(`UPDATE collect_tables
SET status = ?, updated_at = ?
WHERE project_id = ?`);

    for (const status of ['creating', 'failed', 'archived'] as const) {
      updateStatus.run(status, new Date().toISOString(), projectId);
      const rejected = await app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields`,
        headers,
        payload: fieldPayload(`state_${status}`),
      });
      expect(rejected.statusCode, rejected.body).toBe(409);
      expect(rejected.json()).toMatchObject({ error: { code: 'TABLE_STATE_CONFLICT' } });
    }

    updateStatus.run('disabled', new Date().toISOString(), projectId);
    const allowed = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields`,
      headers,
      payload: fieldPayload('disabled_table_field'),
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  it('denies the user role on every DESIGN 15.4 field route', async () => {
    const app = await makeApp();
    const { projectId } = await createTable(app, 'permissions');
    const headers = authorization(app, 'user');
    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields`,
        headers,
        payload: fieldPayload('forbidden_field'),
      }),
      app.inject({
        method: 'PATCH',
        url: `/api/admin/tables/${projectId}/fields/event_name`,
        headers,
        payload: { label: 'Forbidden' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields/event_name/rename`,
        headers,
        payload: { key: 'forbidden_name' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields/event_name/deprecate`,
        headers,
      }),
      app.inject({
        method: 'PUT',
        url: `/api/admin/tables/${projectId}/fields/event_name/options`,
        headers,
        payload: { options: [] },
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields/event_name/retype`,
        headers,
        payload: { type: 'enum', options: [{ value: 'login', label: 'Login' }] },
      }),
      app.inject({
        method: 'DELETE',
        url: `/api/admin/tables/${projectId}/fields/event_name`,
        headers,
        payload: { confirm: 'event_name' },
      }),
      app.inject({
        method: 'GET',
        url: `/api/admin/tables/${projectId}/fields/event_name/usage`,
        headers,
      }),
    ]);

    expect(responses).toHaveLength(8);
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
  });

  it('rejects malformed field keys with INVALID_FIELD_KEY on every entry point', async () => {
    const app = await makeApp();
    const { projectId } = await createTable(app, 'invalid-key');
    const headers = authorization(app, 'admin');

    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/admin/tables',
        headers,
        payload: { ...createPayload('invalid-key-create'), fields: [fieldPayload('Bad-Key')] },
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields`,
        headers,
        payload: fieldPayload('Bad-Key'),
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields/event_name/rename`,
        headers,
        payload: { key: '_private' },
      }),
      app.inject({
        method: 'PATCH',
        url: `/api/admin/tables/${projectId}/fields/Bad-Key`,
        headers,
        payload: { label: 'whatever' },
      }),
      app.inject({
        method: 'GET',
        url: `/api/admin/tables/${projectId}/fields/Bad-Key/usage`,
        headers,
      }),
      app.inject({
        method: 'PUT',
        url: `/api/admin/tables/${projectId}/fields/Bad-Key/options`,
        headers,
        payload: { options: [] },
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields/Bad-Key/retype`,
        headers,
        payload: { type: 'enum', options: [{ value: 'a', label: 'A' }] },
      }),
    ]);

    expect(responses).toHaveLength(7);
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_FIELD_KEY' } });
    }
  });
});
