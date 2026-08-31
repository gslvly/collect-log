import { describe, expect, it } from 'vitest';

import { tablesIntegrationFixtures } from './tables.integration.fixtures.js';

const { tables, operator, makeApp, makeAppWithLogs, authorization, createPayload, createTable } =
  tablesIntegrationFixtures();

describe('stage A-1 collection table acceptance against SQLite and ClickHouse', () => {
  it('enforces every legal and illegal table-state transition through the API', async () => {
    const app = await makeApp();
    const { projectId } = await createTable(app, 'super_admin', 'state-machine');
    const headers = authorization(app, 'admin');

    for (const status of ['disabled', 'active', 'archived', 'active'] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/tables/${projectId}/status`,
        headers,
        payload: { status },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ table: { status } });
    }

    const invalid = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${projectId}/status`,
      headers,
      payload: { status: 'failed' },
    });
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json()).toMatchObject({ error: { code: 'TABLE_STATE_CONFLICT' } });
  });

  it('rotates secrets by retaining the previous key', async () => {
    const app = await makeApp();
    const created = await createTable(app, 'admin', 'secret-rotation');
    const headers = authorization(app, 'super_admin');

    const rotationStartedAt = Date.now();
    const viewed = await app.inject({
      method: 'GET',
      url: `/api/admin/tables/${created.projectId}/secret`,
      headers,
    });
    const rotated = await app.inject({
      method: 'POST',
      url: `/api/admin/tables/${created.projectId}/secret/rotate`,
      headers,
    });
    const rotationFinishedAt = Date.now();
    const current = await tables.findById(created.projectId);

    expect(viewed.statusCode).toBe(200);
    expect(viewed.json()).toEqual(created);
    expect(rotated.statusCode).toBe(200);
    expect(viewed.json()).not.toHaveProperty(['table', 'Id'].join(''));
    expect(viewed.json()).not.toHaveProperty('physicalName');
    expect(rotated.json()).not.toHaveProperty(['table', 'Id'].join(''));
    expect(rotated.json()).not.toHaveProperty('physicalName');
    expect(rotated.json().ingestSecret).not.toBe(created.ingestSecret);
    expect(Buffer.from(rotated.json().ingestSecret as string, 'base64url')).toHaveLength(32);
    expect(current).toMatchObject({
      ingestSecret: rotated.json().ingestSecret,
      ingestSecretPrev: created.ingestSecret,
    });
    const previousSecretExpiresAt = Date.parse(current?.ingestSecretPrevExpiresAt ?? '');
    expect(previousSecretExpiresAt).toBeGreaterThanOrEqual(
      rotationStartedAt + 7 * 24 * 60 * 60 * 1_000,
    );
    expect(previousSecretExpiresAt).toBeLessThanOrEqual(
      rotationFinishedAt + 7 * 24 * 60 * 60 * 1_000,
    );
  });

  it('logs every plaintext read of the ingest secret with its operator', async () => {
    const { app, logs } = await makeAppWithLogs();
    const created = await createTable(app, 'admin', 'secret-read-log');

    const viewed = await app.inject({
      method: 'GET',
      url: `/api/admin/tables/${created.projectId}/secret`,
      headers: authorization(app, 'super_admin'),
    });
    expect(viewed.statusCode).toBe(200);

    const secretLog = logs.find((record) => record.operation === 'read_table_secret');
    expect(secretLog).toMatchObject({
      operator: operator('super_admin'),
      projectId: created.projectId,
      msg: 'collection table ingest secret read',
    });
    // 明文密钥本身绝不能进日志。
    expect(JSON.stringify(logs)).not.toContain(created.ingestSecret);
  });

  it('applies the DESIGN 11.2 permission matrix, including secret denial for user', async () => {
    const app = await makeApp();
    const created = await createTable(app, 'admin', 'permissions');

    for (const role of ['user', 'admin', 'super_admin'] as const) {
      const headers = authorization(app, role);
      const list = await app.inject({ method: 'GET', url: '/api/admin/tables', headers });
      const detail = await app.inject({
        method: 'GET',
        url: `/api/admin/tables/${created.projectId}`,
        headers,
      });
      expect(list.statusCode).toBe(200);
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        table: { projectId: created.projectId },
        fields: [{ key: 'event_name' }, { key: 'is_success' }],
      });
    }

    const userHeaders = authorization(app, 'user');
    const restrictedRequests = [
      app.inject({
        method: 'POST',
        url: '/api/admin/tables',
        headers: userHeaders,
        payload: createPayload('forbidden-create'),
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${created.projectId}/retry`,
        headers: userHeaders,
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${created.projectId}/status`,
        headers: userHeaders,
        payload: { status: 'disabled' },
      }),
      app.inject({
        method: 'GET',
        url: `/api/admin/tables/${created.projectId}/secret`,
        headers: userHeaders,
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/tables/${created.projectId}/secret/rotate`,
        headers: userHeaders,
      }),
    ];
    const restricted = await Promise.all(restrictedRequests);
    for (const response of restricted) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
  });
});
