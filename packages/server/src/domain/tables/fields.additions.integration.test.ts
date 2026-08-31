import { describe, expect, it } from 'vitest';

import { configuredLimits } from '../../config/limits.js';
import {
  authorization,
  createTable,
  fieldPayload,
  makeApp,
  metadataCache,
  systemColumns,
  tables,
  testDatabase,
} from './fields.integration.fixtures.js';

describe('stage A-2 field changes against SQLite and ClickHouse', () => {
  it('adds a float field as a Nullable(Float64) column', async () => {
    const app = await makeApp();
    const { projectId, physicalName } = await createTable(app, 'add-float');
    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields`,
      headers: authorization(app, 'admin'),
      payload: {
        key: 'score',
        label: 'Score',
        type: 'float',
        required: false,
        description: 'Floating-point value',
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      table: { schemaVersion: 2 },
      field: { key: 'score', type: 'float', status: 'active', schemaVersion: 2 },
    });
    await expect(systemColumns(physicalName, ['score'])).resolves.toEqual([
      { name: 'score', type: 'Nullable(Float64)' },
    ]);
  });

  it('adds enum options transactionally, caches only active values, and clears ghost options on rebuild', async () => {
    const app = await makeApp();
    const { projectId, physicalName } = await createTable(app, 'add-enum');
    const headers = authorization(app, 'super_admin');

    await tables.getDefinition(projectId);
    expect(metadataCache.has(projectId)).toBe(true);
    const added = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields`,
      headers,
      payload: {
        key: 'channel',
        label: 'Channel',
        type: 'enum',
        required: false,
        description: '',
        options: [
          { value: 'web', label: 'Web' },
          { value: 'app', label: 'App', status: 'disabled' },
        ],
      },
    });
    expect(added.statusCode, added.body).toBe(200);
    expect(metadataCache.has(projectId)).toBe(false);
    await expect(systemColumns(physicalName, ['channel'])).resolves.toEqual([
      { name: 'channel', type: 'LowCardinality(Nullable(String))' },
    ]);
    expect(
      testDatabase
        .prepare<{ value: string; label: string; status: string; sort_order: number }>(
          `SELECT value, label, status, sort_order
FROM collect_field_options
WHERE project_id = ? AND field_key = ?
ORDER BY sort_order`,
        )
        .all(projectId, 'channel'),
    ).toEqual([
      { value: 'web', label: 'Web', status: 'active', sort_order: 0 },
      { value: 'app', label: 'App', status: 'disabled', sort_order: 1 },
    ]);

    const definition = await tables.getDefinition(projectId);
    expect([
      ...(definition?.fields.find((field) => field.key === 'channel')?.activeOptions ?? []),
    ]).toEqual([['web', 'Web']]);

    const dropped = await app.inject({
      method: 'DELETE',
      url: `/api/admin/tables/${projectId}/fields/channel`,
      headers,
      payload: { confirm: 'channel' },
    });
    expect(dropped.statusCode, dropped.body).toBe(200);
    expect(
      testDatabase
        .prepare<{ count: number }>(
          `SELECT count(*) AS count
FROM collect_field_options
WHERE project_id = ? AND field_key = ?`,
        )
        .get(projectId, 'channel'),
    ).toEqual({ count: 2 });

    const rebuilt = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields`,
      headers,
      payload: fieldPayload('channel'),
    });
    expect(rebuilt.statusCode, rebuilt.body).toBe(200);
    expect(
      testDatabase
        .prepare<{ count: number }>(
          `SELECT count(*) AS count
FROM collect_field_options
WHERE project_id = ? AND field_key = ?`,
        )
        .get(projectId, 'channel'),
    ).toEqual({ count: 0 });
    const rebuiltDefinition = await tables.getDefinition(projectId);
    expect(
      rebuiltDefinition?.fields.find((field) => field.key === 'channel')?.activeOptions.size,
    ).toBe(0);
  });

  it('rejects incompatible options before issuing an ADD COLUMN', async () => {
    const app = await makeApp();
    const { projectId, physicalName } = await createTable(app, 'invalid-options');
    const headers = authorization(app, 'admin');
    const cases = [
      {
        key: 'missing_options',
        label: 'Missing options',
        type: 'enum',
        required: false,
        description: '',
      },
      {
        key: 'disabled_options',
        label: 'Disabled options',
        type: 'enum',
        required: false,
        description: '',
        options: [{ value: 'off', label: 'Off', status: 'disabled' }],
      },
      {
        key: 'unexpected_options',
        label: 'Unexpected options',
        type: 'string',
        required: false,
        description: '',
        options: [],
      },
      {
        key: 'too_many_options',
        label: 'Too many options',
        type: 'enum',
        required: false,
        description: '',
        options: Array.from({ length: configuredLimits.schema.maxEnumOptions + 1 }, (_, index) => ({
          value: `option_${index}`,
          label: `Option ${index}`,
        })),
      },
      {
        key: 'long_option_value',
        label: 'Long option value',
        type: 'enum',
        required: false,
        description: '',
        options: [
          {
            value: 'x'.repeat(configuredLimits.schema.maxOptionValueBytes + 1),
            label: 'Long',
          },
        ],
      },
      {
        key: 'long_option_label',
        label: 'Long option label',
        type: 'enum',
        required: false,
        description: '',
        options: [
          {
            value: 'long_label',
            label: 'x'.repeat(configuredLimits.schema.maxOptionLabelBytes + 1),
          },
        ],
      },
    ];

    for (const payload of cases) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/fields`,
        headers,
        payload,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_FIELD_VALUE' } });
    }
    await expect(
      systemColumns(
        physicalName,
        cases.map((testCase) => testCase.key),
      ),
    ).resolves.toEqual([]);
  });

  it('updates enum options by full diff with exact versioning and no implicit deletion', async () => {
    const app = await makeApp();
    const { projectId } = await createTable(app, 'update-enum-options');
    const headers = authorization(app, 'admin');
    const added = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/fields`,
      headers,
      payload: {
        key: 'channel',
        label: 'Channel',
        type: 'enum',
        required: false,
        description: '',
        options: [
          { value: 'web', label: 'Web' },
          { value: 'app', label: 'App' },
        ],
      },
    });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json()).toMatchObject({
      table: { schemaVersion: 2 },
      field: {
        key: 'channel',
        options: [
          { value: 'web', label: 'Web', status: 'active' },
          { value: 'app', label: 'App', status: 'active' },
        ],
      },
    });

    const displayOnly = await app.inject({
      method: 'PUT',
      url: `/api/admin/tables/${projectId}/fields/channel/options`,
      headers,
      payload: {
        options: [
          { value: 'app', label: 'Native app' },
          { value: 'web', label: 'Browser' },
        ],
      },
    });
    expect(displayOnly.statusCode, displayOnly.body).toBe(200);
    expect(displayOnly.json()).toMatchObject({
      table: { schemaVersion: 2 },
      field: {
        schemaVersion: 2,
        options: [
          { value: 'app', label: 'Native app', status: 'active' },
          { value: 'web', label: 'Browser', status: 'active' },
        ],
      },
    });

    await tables.getDefinition(projectId);
    expect(metadataCache.has(projectId)).toBe(true);
    const validationChange = await app.inject({
      method: 'PUT',
      url: `/api/admin/tables/${projectId}/fields/channel/options`,
      headers,
      payload: {
        options: [
          { value: 'app', label: 'Native app', status: 'disabled' },
          { value: 'web', label: 'Browser' },
          { value: 'mini', label: 'Mini program' },
        ],
      },
    });
    expect(validationChange.statusCode, validationChange.body).toBe(200);
    expect(validationChange.json()).toMatchObject({
      table: { schemaVersion: 3 },
      field: {
        schemaVersion: 3,
        options: [
          { value: 'app', label: 'Native app', status: 'disabled' },
          { value: 'web', label: 'Browser', status: 'active' },
          { value: 'mini', label: 'Mini program', status: 'active' },
        ],
      },
    });
    expect(metadataCache.has(projectId)).toBe(false);
    const definition = await tables.getDefinition(projectId);
    expect([
      ...(definition?.fields.find((field) => field.key === 'channel')?.activeOptions ?? []),
    ]).toEqual([
      ['web', 'Browser'],
      ['mini', 'Mini program'],
    ]);

    const omitted = await app.inject({
      method: 'PUT',
      url: `/api/admin/tables/${projectId}/fields/channel/options`,
      headers,
      payload: {
        options: [
          { value: 'web', label: 'Should roll back' },
          { value: 'mini', label: 'Mini program' },
        ],
      },
    });
    expect(omitted.statusCode, omitted.body).toBe(400);
    expect(omitted.json()).toMatchObject({ error: { code: 'INVALID_FIELD_VALUE' } });
    expect(omitted.json().error.message).toContain('app');
    expect(omitted.json().error.message).toContain('status "disabled"');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/admin/tables/${projectId}`,
      headers,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ table: { schemaVersion: 3 } });
    expect(
      detail.json().fields.find((field: { key: string }) => field.key === 'channel').options,
    ).toEqual([
      { value: 'app', label: 'Native app', status: 'disabled' },
      { value: 'web', label: 'Browser', status: 'active' },
      { value: 'mini', label: 'Mini program', status: 'active' },
    ]);

    const nonEnum = await app.inject({
      method: 'PUT',
      url: `/api/admin/tables/${projectId}/fields/event_name/options`,
      headers,
      payload: { options: [{ value: 'login', label: 'Login' }] },
    });
    expect(nonEnum.statusCode, nonEnum.body).toBe(400);
    expect(nonEnum.json()).toMatchObject({ error: { code: 'INVALID_FIELD_VALUE' } });
  });
});
