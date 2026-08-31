import { describe, expect, it } from 'vitest';

import { configuredLimits } from '../../config/limits.js';
import { AppError } from '../../errors.js';
import {
  assertTrendRange,
  assertValidTimeZone,
  parseDetailQuery,
  parseExportQuery,
  parseStatisticsQuery,
  parseTimeRange,
} from './parse.js';
import { expectInvalidQuery } from './query.test-helpers.js';

describe('query request parsing', () => {
  const day = 86_400_000;

  it('rejects missing, inverted, and overlong time ranges', () => {
    expectInvalidQuery(() => parseTimeRange(undefined, 92));
    expectInvalidQuery(() => parseTimeRange({ start: 10, end: 10 }, 92));
    expectInvalidQuery(() => parseTimeRange({ start: 20, end: 10 }, 92));
    expectInvalidQuery(() => parseTimeRange({ start: 0, end: 92 * day + 1 }, 92));
  });

  it('enforces minute and hour trend range protections', () => {
    expectInvalidQuery(() => assertTrendRange({ start: 0, end: 2 * day + 1 }, 'minute'));
    expectInvalidQuery(() => assertTrendRange({ start: 0, end: 31 * day + 1 }, 'hour'));
    expect(() => assertTrendRange({ start: 0, end: 2 * day }, 'minute')).not.toThrow();
    expect(() => assertTrendRange({ start: 0, end: 31 * day }, 'hour')).not.toThrow();
  });

  it('accepts valid IANA zones and rejects invalid zones', () => {
    expect(assertValidTimeZone('UTC')).toBe('UTC');
    expect(assertValidTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai');
    expectInvalidQuery(() => assertValidTimeZone('Mars/Olympus_Mons'));
  });

  // DESIGN 9.2：时区必须由客户端传，服务端没有任何默认值。
  it('requires the client to supply a time zone and never falls back to a server default', () => {
    const range = { start: 0, end: day };
    const measure = { fn: 'count' };
    for (const tz of [undefined, null, '', 0, {}]) {
      const body = tz === undefined ? { range, measure } : { range, tz, measure };
      expectInvalidQuery(() => parseStatisticsQuery(body, configuredLimits.query));
    }
    // 缺时区的报错必须指名道姓，否则前端只能看到笼统的 "shape" 错误。
    try {
      parseStatisticsQuery({ range, measure }, configuredLimits.query);
      throw new Error('Expected a missing time zone to be rejected');
    } catch (error) {
      expect((error as AppError).message).toContain('IANA time zone');
    }
  });

  // Intl 从 ES2021 起接受 "+08:00"，但 ClickHouse 的 toStartOfDay(x, tz) 只认 tzdata
  // 里的时区名，传偏移串会在 CH 侧抛 Code 36 并最终落到 500。必须在入口挡成 400。
  it('rejects UTC offsets that Intl accepts but ClickHouse cannot resolve', () => {
    for (const offset of ['+08:00', '-05:00', '+0800']) {
      expectInvalidQuery(() => assertValidTimeZone(offset));
    }
    // IANA 别名 ClickHouse 认（已实测），必须放行。
    expect(assertValidTimeZone('Asia/Calcutta')).toBe('Asia/Calcutta');
    expect(assertValidTimeZone('US/Pacific')).toBe('US/Pacific');
    expect(assertValidTimeZone('Etc/GMT-8')).toBe('Etc/GMT-8');
  });

  it('maps all malformed query request bodies to INVALID_QUERY', () => {
    expectInvalidQuery(() => parseDetailQuery({}, configuredLimits.query));
    // 时间维度缺 granularity。
    expectInvalidQuery(() =>
      parseStatisticsQuery(
        {
          range: { start: 0, end: day },
          tz: 'UTC',
          dimension: { kind: 'time' },
          measure: { fn: 'count' },
        },
        configuredLimits.query,
      ),
    );
    // measure 是必填的，没有默认指标。
    expectInvalidQuery(() =>
      parseStatisticsQuery({ range: { start: 0, end: day }, tz: 'UTC' }, configuredLimits.query),
    );
    expectInvalidQuery(() =>
      parseStatisticsQuery(
        { range: { start: 0, end: day }, tz: 'UTC', measure: { fn: 'median', field: 'x' } },
        configuredLimits.query,
      ),
    );
  });

  // DESIGN 9.4.1 / 9.4.2 的两轴入参规则。
  it('parses both statistics axes and enforces their mutually exclusive parameters', () => {
    const range = { start: 0, end: day };
    const base = { range, tz: 'UTC' };

    expect(
      parseStatisticsQuery({ ...base, measure: { fn: 'count' } }, configuredLimits.query),
    ).toEqual({ range, tz: 'UTC', measure: { fn: 'count' } });
    // 省略与显式 null 都表示不分组。
    expect(
      parseStatisticsQuery(
        { ...base, dimension: null, measure: { fn: 'unique', field: 'user_id' } },
        configuredLimits.query,
      ),
    ).toEqual({ range, tz: 'UTC', measure: { fn: 'unique', field: 'user_id' } });
    // axis 默认 _occurred_at。
    expect(
      parseStatisticsQuery(
        { ...base, dimension: { kind: 'time', granularity: 'hour' }, measure: { fn: 'count' } },
        configuredLimits.query,
      ).dimension,
    ).toEqual({ kind: 'time', axis: '_occurred_at', granularity: 'hour' });
    // limit 默认 defaultGroupLimit。
    expect(
      parseStatisticsQuery(
        { ...base, dimension: { kind: 'field', field: 'channel' }, measure: { fn: 'count' } },
        configuredLimits.query,
      ).dimension,
    ).toEqual({
      kind: 'field',
      field: 'channel',
      limit: configuredLimits.query.defaultGroupLimit,
    });

    for (const body of [
      // count 带了 field。
      { ...base, measure: { fn: 'count', field: 'user_id' } },
      // 非 count 缺 field。
      { ...base, measure: { fn: 'sum' } },
      // 时间维度不接受 limit / field。
      {
        ...base,
        dimension: { kind: 'time', granularity: 'day', limit: 10 },
        measure: { fn: 'count' },
      },
      {
        ...base,
        dimension: { kind: 'time', granularity: 'day', field: 'channel' },
        measure: { fn: 'count' },
      },
      // 字段维度不接受 axis / granularity。
      {
        ...base,
        dimension: { kind: 'field', field: 'channel', granularity: 'day' },
        measure: { fn: 'count' },
      },
      { ...base, dimension: { kind: 'field' }, measure: { fn: 'count' } },
      // limit 越界。
      {
        ...base,
        dimension: { kind: 'field', field: 'channel', limit: 0 },
        measure: { fn: 'count' },
      },
      {
        ...base,
        dimension: {
          kind: 'field',
          field: 'channel',
          limit: configuredLimits.query.maxGroupLimit + 1,
        },
        measure: { fn: 'count' },
      },
      // 分钟粒度收紧到 2 天。
      {
        range: { start: 0, end: 2 * day + 1 },
        tz: 'UTC',
        dimension: { kind: 'time', granularity: 'minute' },
        measure: { fn: 'count' },
      },
    ]) {
      expectInvalidQuery(() => parseStatisticsQuery(body, configuredLimits.query));
    }

    // count 带 field 的报错必须指出出路，而不是笼统的「不支持」。
    try {
      parseStatisticsQuery(
        { ...base, measure: { fn: 'count', field: 'user_id' } },
        configuredLimits.query,
      );
      throw new Error('Expected INVALID_QUERY');
    } catch (error) {
      expect((error as AppError).message).toContain('is_not_null');
    }
  });

  it('accepts number filter values in detail, statistics, and export request shapes', () => {
    const filter = { field: 'score', op: 'gte' as const, value: 12.5 };
    expect(
      parseDetailQuery({ range: { start: 0, end: day }, filter }, configuredLimits.query).filter,
    ).toEqual(filter);
    expect(
      parseStatisticsQuery(
        { range: { start: 0, end: day }, tz: 'UTC', measure: { fn: 'count' }, filter },
        configuredLimits.query,
      ).filter,
    ).toEqual(filter);
    expect(
      parseExportQuery({ range: { start: 0, end: day }, filter }, configuredLimits.query).filter,
    ).toEqual(filter);
  });

  it('defaults, de-duplicates, and sorts explicitly included deprecated fields', () => {
    expect(
      parseDetailQuery({ range: { start: 0, end: day } }, configuredLimits.query).includeFields,
    ).toEqual([]);
    expect(
      parseDetailQuery(
        { range: { start: 0, end: day }, includeFields: ['z_field', 'a_field', 'z_field'] },
        configuredLimits.query,
      ).includeFields,
    ).toEqual(['a_field', 'z_field']);
    expect(
      parseExportQuery(
        { range: { start: 0, end: day }, includeFields: ['z_field', 'a_field', 'a_field'] },
        configuredLimits.query,
      ).includeFields,
    ).toEqual(['a_field', 'z_field']);
    expectInvalidQuery(() =>
      parseDetailQuery(
        { range: { start: 0, end: day }, includeFields: ['valid', 1] },
        configuredLimits.query,
      ),
    );
  });
});
