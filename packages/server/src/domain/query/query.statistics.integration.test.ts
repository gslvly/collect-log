import { describe, expect, it } from 'vitest';

import { baseTime, createFixture, queryRange, statistics } from './query.integration.fixtures.js';

describe('stage D query routes against SQLite and ClickHouse', () => {
  // DESIGN 17.3：两个轴的六种组合各自生效，且按天聚合随时区正确变化。
  it('executes the six dimension x measure combinations and shifts day buckets by time zone', async () => {
    const fixture = await createFixture(undefined, true);

    const total = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      measure: { fn: 'count' },
    });
    expect(total.statusCode, total.body).toBe(200);
    expect(total.json()).toEqual({
      dimension: null,
      measure: { fn: 'count' },
      rows: [{ value: 5, rows: 5, share: 1 }],
      totals: { value: 5, rows: 5 },
      truncated: false,
    });

    const utcTrend = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      dimension: { kind: 'time', axis: '_occurred_at', granularity: 'day' },
      measure: { fn: 'count' },
    });
    const shanghaiTrend = await statistics(fixture, {
      range: queryRange,
      tz: 'Asia/Shanghai',
      dimension: { kind: 'time', axis: '_occurred_at', granularity: 'day' },
      measure: { fn: 'count' },
    });
    expect(utcTrend.statusCode, utcTrend.body).toBe(200);
    expect(shanghaiTrend.statusCode, shanghaiTrend.body).toBe(200);
    expect(utcTrend.json().rows).toEqual([
      { key: '2026-08-27T00:00:00.000Z', value: 5, rows: 5, share: 1 },
    ]);
    expect(shanghaiTrend.json().rows).toEqual([
      { key: '2026-08-26T16:00:00.000Z', value: 2, rows: 2, share: 0.4 },
      { key: '2026-08-27T16:00:00.000Z', value: 3, rows: 3, share: 0.6 },
    ]);
    // 时间维度不做 Top N，因此永不截断，也没有「其它」那一档。
    expect(shanghaiTrend.json().truncated).toBe(false);
    expect(shanghaiTrend.json()).not.toHaveProperty('others');
    expect(shanghaiTrend.json()).not.toHaveProperty('nullAxisRows');

    const unique = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      measure: { fn: 'unique', field: 'user_id' },
    });
    expect(unique.statusCode, unique.body).toBe(200);
    expect(unique.json().rows).toEqual([{ value: 3, rows: 5 }]);

    const trendSum = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      dimension: { kind: 'time', axis: '_occurred_at', granularity: 'day' },
      measure: { fn: 'sum', field: 'score' },
    });
    expect(trendSum.statusCode, trendSum.body).toBe(200);
    expect(trendSum.json().rows).toEqual([{ key: '2026-08-27T00:00:00.000Z', value: 60, rows: 5 }]);
    expect(trendSum.json().totals).toEqual({ value: 60, rows: 5 });

    const groupCount = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      dimension: { kind: 'field', field: 'user_id' },
      measure: { fn: 'count' },
    });
    expect(groupCount.statusCode, groupCount.body).toBe(200);
    expect(groupCount.json().rows).toEqual([
      { key: 'u1', value: 2, rows: 2, share: 0.4 },
      { key: '', value: 1, rows: 1, share: 0.2 },
      { key: 'u2', value: 1, rows: 1, share: 0.2 },
      { key: null, value: 1, rows: 1, share: 0.2 },
    ]);
    expect(groupCount.json().totals).toEqual({ value: 5, rows: 5 });
    expect(groupCount.json().others).toEqual({ value: 0 });

    const groupP90 = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      dimension: { kind: 'field', field: 'event_name' },
      measure: { fn: 'p90', field: 'score' },
    });
    expect(groupP90.statusCode, groupP90.body).toBe(200);
    // login 有 score 10 / null / 0，p90 的分母是非空行数（DESIGN 9.4.2）。
    expect(groupP90.json().rows).toEqual([
      { key: 'logout', value: 29, rows: 2 },
      { key: 'login', value: 9, rows: 3 },
    ]);
    // 分位数不可加，因此没有 others，也不给 share。
    expect(groupP90.json()).not.toHaveProperty('others');

    // 能力不匹配的组合（DESIGN 17.3）。
    for (const body of [
      { measure: { fn: 'sum', field: 'event_name' } },
      { dimension: { kind: 'field', field: 'score' }, measure: { fn: 'count' } },
    ]) {
      const rejected = await statistics(fixture, { range: queryRange, tz: 'UTC', ...body });
      expect(rejected.statusCode, rejected.body).toBe(400);
      expect(rejected.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });
    }
  });

  // DESIGN 9.4.3 第二 / 三 / 四条 + 17.3：空桶填充、rows 列、业务时间轴。
  it('fills occurred-at buckets, nulls non-additive empties, and reports nullAxisRows for a business axis', async () => {
    const fixture = await createFixture(undefined, true);

    const minuteCount = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      dimension: { kind: 'time', axis: '_occurred_at', granularity: 'minute' },
      measure: { fn: 'count' },
    });
    expect(minuteCount.statusCode, minuteCount.body).toBe(200);
    const countRows = minuteCount.json().rows as Array<{
      key: string;
      value: number;
      rows: number;
    }>;
    // 15:57 到 16:07 共 11 个桶，其中只有 5 个有数据。
    expect(countRows).toHaveLength(11);
    expect(countRows[0]).toMatchObject({ key: '2026-08-27T15:57:00.000Z', value: 0, rows: 0 });
    expect(countRows.at(-1)).toMatchObject({ key: '2026-08-27T16:07:00.000Z', value: 0, rows: 0 });
    expect(countRows.filter((row) => row.rows === 1)).toHaveLength(5);
    expect(countRows.every((row) => typeof row.rows === 'number')).toBe(true);

    const minuteSum = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      dimension: { kind: 'time', axis: '_occurred_at', granularity: 'minute' },
      measure: { fn: 'sum', field: 'score' },
    });
    expect(minuteSum.statusCode, minuteSum.body).toBe(200);
    const sumRows = minuteSum.json().rows as Array<{ key: string; value: number; rows: number }>;
    expect(sumRows[0]).toMatchObject({ value: 0, rows: 0 });
    expect(sumRows.find((row) => row.key === '2026-08-27T15:58:00.000Z')).toMatchObject({
      value: 10,
      rows: 1,
    });

    for (const fn of ['avg', 'min', 'p90'] as const) {
      const response = await statistics(fixture, {
        range: queryRange,
        tz: 'UTC',
        dimension: { kind: 'time', axis: '_occurred_at', granularity: 'minute' },
        measure: { fn, field: 'score' },
      });
      expect(response.statusCode, response.body).toBe(200);
      const filled = response.json().rows as Array<{ value: number | null; rows: number }>;
      expect(filled[0]).toEqual({ key: '2026-08-27T15:57:00.000Z', value: null, rows: 0 });
      expect(filled.every((row) => row.rows > 0 || row.value === null)).toBe(true);
    }

    // 业务时间轴：另一条趋势、补 IS NOT NULL、返回 nullAxisRows、不做空桶填充。
    const businessTrend = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      dimension: { kind: 'time', axis: 'business_at', granularity: 'minute' },
      measure: { fn: 'count' },
    });
    expect(businessTrend.statusCode, businessTrend.body).toBe(200);
    expect(businessTrend.json().rows).toEqual([
      { key: '2026-08-27T15:57:00.000Z', value: 3, rows: 3, share: 0.75 },
      { key: '2026-08-27T15:58:00.000Z', value: 1, rows: 1, share: 0.25 },
    ]);
    expect(businessTrend.json().nullAxisRows).toBe(1);
    expect(businessTrend.json().totals).toEqual({ value: 4, rows: 4 });

    // 命中 0 行时三种形状都要给出完整的响应，而不是缺 totals 或整个空掉。
    const emptyRange = { start: baseTime - 40 * 60_000, end: baseTime - 20 * 60_000 };
    const emptyPlain = await statistics(fixture, {
      range: emptyRange,
      tz: 'UTC',
      measure: { fn: 'count' },
    });
    expect(emptyPlain.statusCode, emptyPlain.body).toBe(200);
    expect(emptyPlain.json()).toMatchObject({
      rows: [{ value: 0, rows: 0, share: 0 }],
      totals: { value: 0, rows: 0 },
    });

    const emptyGroups = await statistics(fixture, {
      range: emptyRange,
      tz: 'UTC',
      dimension: { kind: 'field', field: 'event_name' },
      measure: { fn: 'count' },
    });
    expect(emptyGroups.statusCode, emptyGroups.body).toBe(200);
    expect(emptyGroups.json()).toMatchObject({
      rows: [],
      totals: { value: 0, rows: 0 },
      others: { value: 0 },
      truncated: false,
    });

    const emptyTrend = await statistics(fixture, {
      range: emptyRange,
      tz: 'UTC',
      dimension: { kind: 'time', axis: '_occurred_at', granularity: 'minute' },
      measure: { fn: 'avg', field: 'score' },
    });
    expect(emptyTrend.statusCode, emptyTrend.body).toBe(200);
    expect(emptyTrend.json().rows).toHaveLength(20);
    expect(emptyTrend.json().rows.every((row: { value: null }) => row.value === null)).toBe(true);
    expect(emptyTrend.json().totals).toEqual({ value: null, rows: 0 });
  });

  // DESIGN 9.4.4：分组数超过 limit 时 truncated 为 true，
  // 且只有 count / sum 额外给出 others。
  it('truncates the field dimension with limit + 1 and only offers others for additive measures', async () => {
    const fixture = await createFixture(undefined, true);

    const truncatedCount = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      dimension: { kind: 'field', field: 'user_id', limit: 2 },
      measure: { fn: 'count' },
    });
    expect(truncatedCount.statusCode, truncatedCount.body).toBe(200);
    expect(truncatedCount.json().rows).toHaveLength(2);
    expect(truncatedCount.json().truncated).toBe(true);
    expect(truncatedCount.json().totals).toEqual({ value: 5, rows: 5 });
    expect(truncatedCount.json().others).toEqual({ value: 2 });

    const truncatedSum = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      dimension: { kind: 'field', field: 'event_name', limit: 1 },
      measure: { fn: 'sum', field: 'score' },
    });
    expect(truncatedSum.statusCode, truncatedSum.body).toBe(200);
    expect(truncatedSum.json().rows).toEqual([{ key: 'logout', value: 50, rows: 2 }]);
    expect(truncatedSum.json().truncated).toBe(true);
    expect(truncatedSum.json().others).toEqual({ value: 10 });

    for (const measure of [
      { fn: 'avg', field: 'score' },
      { fn: 'unique', field: 'safe_integer' },
      { fn: 'p50', field: 'score' },
    ]) {
      const response = await statistics(fixture, {
        range: queryRange,
        tz: 'UTC',
        dimension: { kind: 'field', field: 'event_name', limit: 1 },
        measure,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().truncated).toBe(true);
      expect(response.json()).not.toHaveProperty('others');
    }
  });
});
