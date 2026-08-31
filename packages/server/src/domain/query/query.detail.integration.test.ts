import { describe, expect, it } from 'vitest';

import {
  authorization,
  baseTime,
  createFixture,
  query,
  queryRange,
  statistics,
} from './query.integration.fixtures.js';

describe('stage D query routes against SQLite and ClickHouse', () => {
  it('enforces V4 float operators, range NULL semantics, and typed output encoding', async () => {
    const fixture = await createFixture(undefined, true);

    const greaterOrEqual = await query(fixture, {
      range: queryRange,
      filter: { field: 'score', op: 'gte', value: 20 },
    });
    expect(greaterOrEqual.statusCode, greaterOrEqual.body).toBe(200);
    expect(greaterOrEqual.json().rows.map((row: Record<string, unknown>) => row.score)).toEqual([
      30, 20,
    ]);
    const encodedRow = greaterOrEqual
      .json()
      .rows.find((row: Record<string, unknown>) => row.score === 20) as Record<string, unknown>;
    expect(encodedRow.safe_integer).toBe(2);
    expect(encodedRow.business_at).toBe(new Date(baseTime - 3_000).toISOString());

    const nullableLessOrEqual = await query(fixture, {
      range: queryRange,
      order: 'asc',
      filter: { field: 'score', op: 'lte', value: 10 },
    });
    expect(nullableLessOrEqual.statusCode, nullableLessOrEqual.body).toBe(200);
    expect(
      nullableLessOrEqual.json().rows.map((row: Record<string, unknown>) => row.score),
    ).toEqual([10, 0]);

    const membership = await query(fixture, {
      range: queryRange,
      filter: { field: 'score', op: 'in', value: [0, 20] },
    });
    expect(membership.statusCode, membership.body).toBe(400);
    expect(membership.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });

    const total = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      measure: { fn: 'count' },
      filter: { field: 'score', op: 'gt', value: 10 },
    });
    expect(total.statusCode, total.body).toBe(200);
    expect(total.json()).toEqual({
      dimension: null,
      measure: { fn: 'count' },
      rows: [{ value: 2, rows: 2, share: 1 }],
      totals: { value: 2, rows: 2 },
      truncated: false,
    });

    const trend = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      dimension: { kind: 'time', granularity: 'day' },
      measure: { fn: 'count' },
      filter: { field: 'score', op: 'gt', value: 10 },
    });
    expect(trend.statusCode, trend.body).toBe(200);
    expect(trend.json().rows).toEqual([
      { key: '2026-08-27T00:00:00.000Z', value: 2, rows: 2, share: 1 },
    ]);

    for (const payload of [
      { range: queryRange, filter: { field: 'score', op: 'contains', value: '2' } },
      { range: queryRange, filter: { field: 'score', op: 'eq', value: 20 } },
    ]) {
      const response = await query(fixture, payload);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });
    }

    // float 没有 uniquable，message 必须点名字段、类型与 fn（DESIGN 9.4.2）。
    const aggregate = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      measure: { fn: 'unique', field: 'score' },
    });
    expect(aggregate.statusCode, aggregate.body).toBe(400);
    expect(aggregate.json()).toMatchObject({
      error: {
        code: 'INVALID_QUERY',
        message: 'Field "score" of type float does not support measure "unique"',
      },
    });

    const integerUnique = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      measure: { fn: 'unique', field: 'safe_integer' },
    });
    expect(integerUnique.statusCode, integerUnique.body).toBe(200);
    expect(integerUnique.json()).toEqual({
      dimension: null,
      measure: { fn: 'unique', field: 'safe_integer' },
      rows: [{ value: 4, rows: 5 }],
      totals: { value: 4, rows: 5 },
      truncated: false,
    });

    // integer 的聚合结果与 datetime 的 min / max 编码（DESIGN 9.1 / 9.4.2）。
    const integerMax = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      measure: { fn: 'max', field: 'safe_integer' },
    });
    expect(integerMax.statusCode, integerMax.body).toBe(200);
    expect(integerMax.json().rows[0].value).toBe(9_007_199_254_740_000);

    const datetimeMin = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      measure: { fn: 'min', field: 'business_at' },
    });
    expect(datetimeMin.statusCode, datetimeMin.body).toBe(200);
    expect(datetimeMin.json().rows[0].value).toBe(new Date(baseTime - 4_000).toISOString());

    // DESIGN 9.4.4：key 为 null 的那一档（未提交该字段）必须作为正常结果返回。
    const booleanGroups = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      dimension: { kind: 'field', field: 'is_success' },
      measure: { fn: 'count' },
    });
    expect(booleanGroups.statusCode, booleanGroups.body).toBe(200);
    const booleanBody = booleanGroups.json();
    expect(booleanBody.totals).toEqual({ value: 5, rows: 5 });
    expect(booleanBody.others).toEqual({ value: 0 });
    expect(booleanBody.truncated).toBe(false);
    expect(
      [...booleanBody.rows].sort((left: { value: number }, right: { value: number }) =>
        String(left.value).localeCompare(String(right.value)),
      ),
    ).toHaveLength(3);
    expect(booleanBody.rows.find((row: { key: unknown }) => row.key === null)).toMatchObject({
      value: 2,
      rows: 2,
    });
    expect(booleanBody.rows.find((row: { key: unknown }) => row.key === true)).toMatchObject({
      value: 2,
      rows: 2,
    });
    expect(booleanBody.rows.find((row: { key: unknown }) => row.key === false)).toMatchObject({
      value: 1,
      rows: 1,
    });
    expect(
      booleanBody.rows.reduce((sum: number, row: { share: number }) => sum + row.share, 0),
    ).toBeCloseTo(1, 10);

    const exported = await fixture.app.inject({
      method: 'POST',
      url: `/api/admin/tables/${fixture.projectId}/export`,
      headers: authorization(fixture.app, 'user'),
      payload: { range: queryRange, order: 'asc' },
    });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.body).toContain('9007199254740000');
    expect(exported.body).toContain(new Date(baseTime - 4_000).toISOString());
  });

  it('returns precise nullable detail rows and paginates in both directions without gaps', async () => {
    const fixture = await createFixture();
    const headers = authorization(fixture.app, 'user');
    const allRows: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;

    do {
      const response = await query(fixture, {
        range: queryRange,
        limit: 2,
        order: 'asc',
        ...(cursor === null ? {} : { cursor }),
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as {
        rows: Array<Record<string, unknown>>;
        nextCursor: string | null;
        hasMore: boolean;
      };
      allRows.push(...body.rows);
      cursor = body.nextCursor;
      if (!body.hasMore) {
        expect(body.nextCursor).toBeNull();
      }
    } while (cursor !== null);

    expect(allRows).toHaveLength(5);
    expect(new Set(allRows.map((row) => row._record_id))).toEqual(new Set(fixture.recordIds));
    expect(new Set(allRows.map((row) => row._record_id)).size).toBe(5);
    expect(allRows[0]).toMatchObject({
      _record_id: fixture.recordIds[0],
      _occurred_at: new Date(fixture.occurredAt[0] ?? 0).toISOString(),
      event_name: 'login',
      user_id: 'u1',
      is_success: true,
      note: null,
    });
    expect(allRows[0]).not.toHaveProperty('physical_name');

    const ascending = await query(fixture, { range: queryRange, limit: 5, order: 'asc' });
    const descending = await query(fixture, { range: queryRange, limit: 5, order: 'desc' });
    expect(ascending.json().rows[0]._record_id).toBe(fixture.recordIds[0]);
    expect(descending.json().rows[0]._record_id).toBe(fixture.recordIds[4]);

    const combinedFilter = await query(fixture, {
      range: queryRange,
      filter: {
        op: 'and',
        conditions: [
          { field: 'event_name', op: 'contains', value: 'login' },
          { field: 'is_success', op: 'eq', value: true },
        ],
      },
    });
    expect(combinedFilter.statusCode, combinedFilter.body).toBe(200);
    expect(
      combinedFilter.json().rows.map((row: Record<string, unknown>) => row._record_id),
    ).toEqual([fixture.recordIds[3], fixture.recordIds[0]]);

    const nullableNegativeFilter = await query(fixture, {
      range: queryRange,
      order: 'asc',
      filter: { field: 'user_id', op: 'neq', value: 'u1' },
    });
    expect(nullableNegativeFilter.statusCode, nullableNegativeFilter.body).toBe(200);
    expect(
      nullableNegativeFilter.json().rows.map((row: Record<string, unknown>) => row.user_id),
    ).toEqual(['u2', '', null]);

    const firstPage = await query(fixture, { range: queryRange, limit: 2 });
    const mismatched = await fixture.app.inject({
      method: 'POST',
      url: `/api/admin/tables/${fixture.projectId}/query`,
      headers,
      payload: {
        range: queryRange,
        limit: 2,
        cursor: firstPage.json().nextCursor,
        filter: { field: 'event_name', op: 'eq', value: 'login' },
      },
    });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });
  });
});
