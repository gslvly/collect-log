import { describe, expect, it } from 'vitest';

import {
  authorization,
  createFixture,
  query,
  queryRange,
  setStatus,
  statistics,
} from './query.integration.fixtures.js';

describe('stage D query routes against SQLite and ClickHouse', () => {
  it('streams CSVWithNames and marks an injected one-row truncation', async () => {
    const full = await createFixture();
    const fullResponse = await full.app.inject({
      method: 'POST',
      url: `/api/admin/tables/${full.projectId}/export`,
      headers: {
        ...authorization(full.app, 'user'),
        origin: 'https://console.example.test',
      },
      payload: { range: queryRange, order: 'asc' },
    });
    expect(fullResponse.statusCode, fullResponse.body).toBe(200);
    expect(fullResponse.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(fullResponse.headers['access-control-expose-headers']).toBe(
      'Content-Disposition, X-Export-Truncated, X-Request-Id',
    );
    expect(fullResponse.headers['content-disposition']).toMatch(
      new RegExp(`^attachment; filename="collect_${full.projectId}_\\d{14}\\.csv"$`),
    );
    const fullLines = fullResponse.body.trimEnd().split('\n');
    expect(fullLines[0]).toContain('_record_id');
    expect(fullLines[0]).toContain('event_name');
    expect(fullLines).toHaveLength(6);

    const truncated = await createFixture(1);
    const truncatedResponse = await truncated.app.inject({
      method: 'POST',
      url: `/api/admin/tables/${truncated.projectId}/export`,
      headers: authorization(truncated.app, 'user'),
      payload: { range: queryRange },
    });
    expect(truncatedResponse.statusCode, truncatedResponse.body).toBe(200);
    expect(truncatedResponse.headers['x-export-truncated']).toBe('1');
    const truncatedLines = truncatedResponse.body.trimEnd().split('\n');
    expect(truncatedLines).toHaveLength(3);
    expect(truncatedLines.at(-1)).toBe('# truncated: exported 1 of 5 rows');
  });

  it('logs the operator and the four request elements for a hijacked export response', async () => {
    const fixture = await createFixture();
    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/admin/tables/${fixture.projectId}/export`,
      headers: authorization(fixture.app, 'user'),
      payload: { range: queryRange, order: 'asc' },
    });
    expect(response.statusCode, response.body).toBe(200);

    const operationLog = fixture.logs.find(
      (record) => record.msg === 'collection data query completed',
    );
    expect(operationLog).toMatchObject({
      operator: 'stage-d-user',
      projectId: fixture.projectId,
      operation: 'export',
      rowCount: 5,
    });

    // hijack 跳过了 onResponse 钩子，DESIGN 12.4 的四要素必须由导出自己补上。
    const requestLog = fixture.logs.find(
      (record) => record.msg === 'request completed' && record.bodyComplete === true,
    );
    expect(requestLog).toMatchObject({
      route: '/api/admin/tables/:projectId/export',
      statusCode: 200,
      bodyComplete: true,
    });
    expect(requestLog?.requestId).toMatch(/^req_/);
    expect(typeof requestLog?.durationMs).toBe('number');
  });

  it('records the operator on a failed query without leaking it from an unauthenticated request', async () => {
    const fixture = await createFixture();
    const rejected = await fixture.app.inject({
      method: 'POST',
      url: `/api/admin/tables/${fixture.projectId}/query`,
      headers: authorization(fixture.app, 'user'),
      payload: { range: queryRange, filter: { field: 'no_such_field', op: 'eq', value: 'x' } },
    });
    expect(rejected.statusCode).toBe(400);

    const unauthenticated = await fixture.app.inject({
      method: 'POST',
      url: `/api/admin/tables/${fixture.projectId}/query`,
      payload: { range: queryRange },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const failures = fixture.logs.filter((record) => record.msg === 'collection data query failed');
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ operator: 'stage-d-user', operation: 'query' });
    expect(failures[1]?.operator).toBeUndefined();
  });

  it('enforces table states and route roles while keeping archived data queryable', async () => {
    const fixture = await createFixture();
    const queryPayload = { range: queryRange };

    for (const status of ['creating', 'failed'] as const) {
      setStatus(fixture, status);
      const response = await query(fixture, queryPayload);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'TABLE_NOT_READY' } });
    }

    setStatus(fixture, 'archived');
    const archivedQuery = await query(fixture, queryPayload);
    expect(archivedQuery.statusCode, archivedQuery.body).toBe(200);
    const rowCount = await fixture.app.inject({
      method: 'GET',
      url: `/api/admin/tables/${fixture.projectId}/row-count`,
      headers: authorization(fixture.app, 'admin'),
    });
    expect(rowCount.statusCode, rowCount.body).toBe(200);
    expect(rowCount.json()).toEqual({ count: 5 });

    const userStatistics = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      measure: { fn: 'count' },
    });
    const userExport = await fixture.app.inject({
      method: 'POST',
      url: `/api/admin/tables/${fixture.projectId}/export`,
      headers: authorization(fixture.app, 'user'),
      payload: queryPayload,
    });
    const forbiddenCount = await fixture.app.inject({
      method: 'GET',
      url: `/api/admin/tables/${fixture.projectId}/row-count`,
      headers: authorization(fixture.app, 'user'),
    });
    expect(userStatistics.statusCode, userStatistics.body).toBe(200);
    expect(userExport.statusCode, userExport.body).toBe(200);
    expect(forbiddenCount.statusCode).toBe(403);
    expect(forbiddenCount.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

    const unauthenticatedRequests = await Promise.all([
      fixture.app.inject({
        method: 'POST',
        url: `/api/admin/tables/${fixture.projectId}/query`,
        payload: queryPayload,
      }),
      fixture.app.inject({
        method: 'POST',
        url: `/api/admin/tables/${fixture.projectId}/statistics`,
        payload: { ...queryPayload, tz: 'UTC', measure: { fn: 'count' } },
      }),
      fixture.app.inject({
        method: 'POST',
        url: `/api/admin/tables/${fixture.projectId}/export`,
        payload: queryPayload,
      }),
      fixture.app.inject({
        method: 'GET',
        url: `/api/admin/tables/${fixture.projectId}/row-count`,
      }),
    ]);
    for (const response of unauthenticatedRequests) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    }
  });
});
