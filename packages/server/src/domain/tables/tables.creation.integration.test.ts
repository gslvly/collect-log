import { describe, expect, it } from 'vitest';

import { metaClient, parameterizedQuery } from '../../infra/clickhouse.js';
import { tablesIntegrationFixtures } from './tables.integration.fixtures.js';

interface SystemTableRow {
  name: string;
}

interface SystemColumnRow {
  name: string;
  type: string;
  default_kind: string;
  default_expression: string;
}

const { namespace, testDatabase, tables, operator, makeApp, authorization, createTable } =
  tablesIntegrationFixtures();

describe('stage A-1 collection table acceptance against SQLite and ClickHouse', () => {
  it('creates metadata, the physical table, and exact system/custom column types', async () => {
    const app = await makeApp();
    const created = await createTable(app, 'admin', 'physical-schema', true);
    const table = await tables.findById(created.projectId);

    expect(created.projectId).toMatch(/^prj_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(Buffer.from(created.ingestSecret, 'base64url')).toHaveLength(32);
    expect(table).toMatchObject({
      projectId: created.projectId,
      status: 'active',
      schemaVersion: 1,
      ingestSecret: created.ingestSecret,
      ingestSecretPrevExpiresAt: null,
      createdBy: operator('admin'),
    });

    const physicalName = table?.physicalName ?? '';
    const physicalTables = await parameterizedQuery<SystemTableRow>({
      client: metaClient,
      query: `SELECT name
FROM system.tables
WHERE database = {database:String}
  AND name = {name:String}`,
      params: { database: 'data', name: physicalName },
    });
    expect(physicalTables).toEqual([{ name: physicalName }]);

    const columns = await parameterizedQuery<SystemColumnRow>({
      client: metaClient,
      query: `SELECT name, type, default_kind, default_expression
FROM system.columns
WHERE database = {database:String}
  AND table = {table:String}
ORDER BY position`,
      params: { database: 'data', table: physicalName },
    });
    expect(columns).toEqual([
      {
        name: '_record_id',
        type: 'UUID',
        default_kind: '',
        default_expression: '',
      },
      {
        name: '_schema_version',
        type: 'UInt32',
        default_kind: '',
        default_expression: '',
      },
      {
        name: '_occurred_at',
        type: "DateTime64(3, 'UTC')",
        default_kind: '',
        default_expression: '',
      },
      {
        name: '_received_at',
        type: "DateTime64(3, 'UTC')",
        default_kind: 'DEFAULT',
        default_expression: 'now64(3)',
      },
      {
        name: 'event_name',
        type: 'Nullable(String)',
        default_kind: '',
        default_expression: '',
      },
      {
        name: 'is_success',
        type: 'Nullable(Bool)',
        default_kind: '',
        default_expression: '',
      },
      {
        name: 'channel',
        type: 'LowCardinality(Nullable(String))',
        default_kind: '',
        default_expression: '',
      },
      {
        name: 'retry_count',
        type: 'Nullable(Int64)',
        default_kind: '',
        default_expression: '',
      },
      {
        name: 'score',
        type: 'Nullable(Float64)',
        default_kind: '',
        default_expression: '',
      },
      {
        name: 'registered_at',
        type: "Nullable(DateTime64(3, 'UTC'))",
        default_kind: '',
        default_expression: '',
      },
    ]);

    expect(
      testDatabase
        .prepare<{ value: string; label: string; status: string; sort_order: number }>(
          `SELECT value, label, status, sort_order
FROM collect_field_options
WHERE project_id = ? AND field_key = ?
ORDER BY sort_order`,
        )
        .all(created.projectId, 'channel'),
    ).toEqual([
      { value: 'web', label: 'Web', status: 'active', sort_order: 0 },
      { value: 'app', label: 'App', status: 'disabled', sort_order: 1 },
    ]);
    const definition = await tables.getDefinition(created.projectId);
    expect([
      ...(definition?.fields.find((field) => field.key === 'channel')?.activeOptions ?? []),
    ]).toEqual([['web', 'Web']]);
  });

  it('rejects incompatible create-table options with INVALID_FIELD_VALUE', async () => {
    const app = await makeApp();
    const headers = authorization(app, 'admin');
    const cases = [
      {
        key: 'channel',
        label: 'Channel',
        type: 'enum',
        required: false,
        description: '',
      },
      {
        key: 'event_name',
        label: 'Event name',
        type: 'string',
        required: false,
        description: '',
        options: [{ value: 'x', label: 'X' }],
      },
    ];

    for (const [index, field] of cases.entries()) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/tables',
        headers,
        payload: {
          displayName: `${namespace}invalid-options-${index}`,
          description: '',
          fields: [field],
        },
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_FIELD_VALUE' } });
    }
  });
});
