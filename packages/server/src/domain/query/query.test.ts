import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { configuredLimits } from '../../config/limits.js';
import { AppError } from '../../errors.js';
import { classifyClickHouseError } from '../../infra/clickhouse.js';
import type { ActiveField, TableDefinition } from '../tables/types.js';
import { decodeCursor, encodeCursor, queryFingerprint } from './cursor.js';
import { buildFilterSql } from './filter.js';
import {
  assertTrendRange,
  assertValidTimeZone,
  parseDetailQuery,
  parseStatisticsQuery,
  parseTimeRange,
} from './parse.js';
import {
  buildDetailStatement,
  buildExportStatement,
  buildRowCountStatement,
  buildStatisticsStatement,
} from './sql.js';
import type { Condition } from './types.js';

const fields: ActiveField[] = [
  {
    key: 'event_name',
    label: 'Event name',
    type: 'string',
    required: false,
    description: '',
    schemaVersion: 3,
  },
  {
    key: 'is_success',
    label: 'Success',
    type: 'boolean',
    required: false,
    description: '',
    schemaVersion: 3,
  },
];

const definition: TableDefinition = {
  projectId: 'prj_01K3QJ4SMNTN8Y5F5RZ6J7B8C9',
  physicalName: 'collect_deadbeef',
  displayName: 'Query fixture',
  description: '',
  status: 'active',
  schemaVersion: 3,
  ingestSecret: '',
  ingestSecretPrev: '',
  ingestSecretPrevExpiresAt: null,
  createdBy: 'tester',
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
  fields,
};

function expectInvalidQuery(action: () => unknown): void {
  try {
    action();
    throw new Error('Expected INVALID_QUERY');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INVALID_QUERY');
  }
}

describe('query filter SQL builder', () => {
  it.each([
    [
      { field: 'event_name', op: 'eq', value: 'login' },
      '`event_name` = {p0:String}',
      { p0: 'login' },
    ],
    [
      { field: 'event_name', op: 'neq', value: 'login' },
      '(`event_name` IS NULL OR `event_name` != {p0:String})',
      { p0: 'login' },
    ],
    [
      { field: 'event_name', op: 'in', value: ['login', 'logout'] },
      '`event_name` IN ({p0:String}, {p1:String})',
      { p0: 'login', p1: 'logout' },
    ],
    [
      { field: 'event_name', op: 'not_in', value: ['login', 'logout'] },
      '(`event_name` IS NULL OR `event_name` NOT IN ({p0:String}, {p1:String}))',
      { p0: 'login', p1: 'logout' },
    ],
    [
      { field: 'event_name', op: 'contains', value: '%login_' },
      'position(`event_name`, {p0:String}) > 0',
      { p0: '%login_' },
    ],
    [
      { field: 'event_name', op: 'not_contains', value: 'login' },
      '(`event_name` IS NULL OR position(`event_name`, {p0:String}) = 0)',
      { p0: 'login' },
    ],
    [{ field: 'event_name', op: 'is_null' }, '`event_name` IS NULL', {}],
    [{ field: 'event_name', op: 'is_not_null' }, '`event_name` IS NOT NULL', {}],
  ] as const)('builds every string operator for %#', (condition, sql, params) => {
    expect(buildFilterSql(condition as Condition, fields, configuredLimits.query)).toEqual({
      sql,
      params,
    });
  });

  it.each([
    [{ field: 'is_success', op: 'eq', value: true }, '`is_success` = {p0:Bool}', { p0: true }],
    [{ field: 'is_success', op: 'is_null' }, '`is_success` IS NULL', {}],
    [{ field: 'is_success', op: 'is_not_null' }, '`is_success` IS NOT NULL', {}],
  ] as const)('builds every boolean operator for %#', (condition, sql, params) => {
    expect(buildFilterSql(condition as Condition, fields, configuredLimits.query)).toEqual({
      sql,
      params,
    });
  });

  it('keeps explicit NULL inclusion in all three negative string operators', () => {
    const conditions: Condition[] = [
      { field: 'event_name', op: 'neq', value: 'x' },
      { field: 'event_name', op: 'not_in', value: ['x'] },
      { field: 'event_name', op: 'not_contains', value: 'x' },
    ];

    for (const condition of conditions) {
      expect(buildFilterSql(condition, fields, configuredLimits.query).sql).toContain(
        '`event_name` IS NULL OR',
      );
    }
  });

  it('parenthesizes nested and/or groups and numbers parameters on the server', () => {
    const condition: Condition = {
      op: 'and',
      conditions: [
        { field: 'event_name', op: 'eq', value: 'login' },
        {
          op: 'or',
          conditions: [
            { field: 'is_success', op: 'eq', value: true },
            { field: 'is_success', op: 'is_null' },
          ],
        },
      ],
    };

    expect(buildFilterSql(condition, fields, configuredLimits.query)).toEqual({
      sql: '(`event_name` = {p0:String} AND (`is_success` = {p1:Bool} OR `is_success` IS NULL))',
      params: { p0: 'login', p1: true },
    });
  });

  it('rejects condition-count, nesting, empty-group, field, and type violations', () => {
    expectInvalidQuery(() =>
      buildFilterSql(
        {
          op: 'and',
          conditions: Array.from({ length: 33 }, () => ({
            field: 'event_name',
            op: 'eq' as const,
            value: 'x',
          })),
        },
        fields,
        configuredLimits.query,
      ),
    );
    expectInvalidQuery(() =>
      buildFilterSql(
        { field: 'event_name', op: 'in', value: Array.from({ length: 33 }, () => 'x') },
        fields,
        configuredLimits.query,
      ),
    );
    expectInvalidQuery(() =>
      buildFilterSql(
        {
          op: 'and',
          conditions: [
            {
              op: 'and',
              conditions: [
                {
                  op: 'and',
                  conditions: [
                    {
                      op: 'and',
                      conditions: [{ field: 'event_name', op: 'eq', value: 'x' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        fields,
        configuredLimits.query,
      ),
    );
    expectInvalidQuery(() =>
      buildFilterSql({ op: 'or', conditions: [] }, fields, configuredLimits.query),
    );
    expectInvalidQuery(() =>
      buildFilterSql(
        { field: 'unknown_field', op: 'eq', value: 'x' },
        fields,
        configuredLimits.query,
      ),
    );
    // A retired field is absent from the active Schema whitelist and is therefore unknown.
    expectInvalidQuery(() =>
      buildFilterSql(
        { field: 'legacy_value', op: 'eq', value: 'x' },
        fields,
        configuredLimits.query,
      ),
    );
    expectInvalidQuery(() =>
      buildFilterSql(
        { field: 'is_success', op: 'contains', value: 'true' },
        fields,
        configuredLimits.query,
      ),
    );
    expectInvalidQuery(() =>
      buildFilterSql(
        { field: 'event_name', op: 'eq', value: true },
        fields,
        configuredLimits.query,
      ),
    );
  });
});

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
    for (const tz of [undefined, null, '', 0, {}]) {
      const body = tz === undefined ? { range, metric: 'total' } : { range, tz, metric: 'total' };
      expectInvalidQuery(() => parseStatisticsQuery(body, configuredLimits.query));
    }
    // 缺时区的报错必须指名道姓，否则前端只能看到笼统的 "shape" 错误。
    try {
      parseStatisticsQuery({ range, metric: 'total' }, configuredLimits.query);
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
    expectInvalidQuery(() =>
      parseStatisticsQuery(
        {
          range: { start: 0, end: day },
          tz: 'UTC',
          metric: 'trend',
        },
        configuredLimits.query,
      ),
    );
  });
});

describe('keyset cursor', () => {
  const fingerprint = queryFingerprint({
    projectId: definition.projectId,
    range: { start: 1, end: 2 },
    order: 'desc',
    schemaVersion: definition.schemaVersion,
  });

  it('round-trips a valid opaque base64url cursor', () => {
    const payload = { at: 1_777_777_777_123, id: randomUUID(), fp: fingerprint };
    expect(decodeCursor(encodeCursor(payload), fingerprint)).toEqual(payload);
  });

  it('rejects fingerprint mismatch and damaged base64', () => {
    const cursor = encodeCursor({ at: 1, id: randomUUID(), fp: fingerprint });
    expectInvalidQuery(() => decodeCursor(cursor, '0'.repeat(16)));
    expectInvalidQuery(() => decodeCursor('not+base64!', fingerprint));
    expectInvalidQuery(() =>
      decodeCursor(
        Buffer.from(JSON.stringify({ at: 'invalid', id: randomUUID(), fp: fingerprint })).toString(
          'base64url',
        ),
        fingerprint,
      ),
    );
  });
});

describe('query SQL generation', () => {
  const range = { start: 1_777_777_000_000, end: 1_777_778_000_000 };
  const emptyFilter = { sql: '', params: {} };

  it('expands explicit current columns, uses tuple keyset pagination, and never uses FINAL', () => {
    const base = buildDetailStatement(definition, { range, limit: 10, order: 'desc' }, emptyFilter);
    const withCursor = buildDetailStatement(
      definition,
      {
        range,
        limit: 10,
        order: 'desc',
        cursor: encodeCursor({ at: range.start, id: randomUUID(), fp: base.fingerprint }),
      },
      emptyFilter,
    );

    expect(withCursor.query).toContain(
      'SELECT `_record_id`, `_occurred_at`, `_received_at`, `_schema_version`, `event_name`, `is_success`',
    );
    expect(withCursor.query).toContain(
      "(`_occurred_at`, `_record_id`) < ({c_at:DateTime64(3, 'UTC')}, {c_id:UUID})",
    );
    expect(withCursor.query).not.toMatch(/SELECT\s+\*/i);
    expect(withCursor.query).not.toMatch(/\bFINAL\b/i);
  });

  // 不带时区的 {x:DateTime64(3)} 会按 ClickHouse 的 session/server 时区解析入参字符串，
  // CH 配成非 UTC 时整个时间窗会整体偏移。所有时间参数都必须锁死 'UTC'。
  it('pins every DateTime64 query parameter to UTC', () => {
    const statements = [
      buildDetailStatement(definition, { range, limit: 10, order: 'desc' }, emptyFilter).query,
      buildDetailStatement(
        definition,
        {
          range,
          limit: 10,
          order: 'desc',
          cursor: encodeCursor({
            at: range.start,
            id: randomUUID(),
            fp: buildDetailStatement(definition, { range, limit: 10, order: 'desc' }, emptyFilter)
              .fingerprint,
          }),
        },
        emptyFilter,
      ).query,
      buildStatisticsStatement(definition, { range, tz: 'UTC', metric: 'total' }, emptyFilter)
        .query,
      buildExportStatement(definition, { range, order: 'asc' }, emptyFilter, 1_000_000).query,
    ];
    for (const query of statements) {
      expect(query).not.toMatch(/DateTime64\(3\)/);
      for (const match of query.matchAll(/DateTime64\([^)]*\)/g)) {
        expect(match[0]).toBe("DateTime64(3, 'UTC')");
      }
    }
  });

  it('keeps every statistics, export, and row-count statement free of FINAL', () => {
    const statements = [
      ...[
        { range, tz: 'UTC', metric: 'total' as const },
        { range, tz: 'UTC', metric: 'trend' as const, granularity: 'day' as const },
        { range, tz: 'UTC', metric: 'unique' as const, field: 'event_name' },
        {
          range,
          tz: 'UTC',
          metric: 'group' as const,
          field: 'event_name',
          limit: 50,
        },
        { range, tz: 'UTC', metric: 'boolean_ratio' as const, field: 'is_success' },
      ].map((input) => buildStatisticsStatement(definition, input, emptyFilter)),
      buildExportStatement(definition, { range, order: 'asc' }, emptyFilter, 1_000_000),
      buildRowCountStatement(definition),
    ];
    for (const statement of statements) {
      expect(statement.query).not.toMatch(/\bFINAL\b/i);
    }
  });
});

describe('ClickHouse error classification', () => {
  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND'])(
    'classifies %s as unavailable',
    (code) => {
      expect(classifyClickHouseError(Object.assign(new Error('network error'), { code }))).toBe(
        'unavailable',
      );
    },
  );

  it('classifies connection messages, aborts, nested causes, limits, and server errors', () => {
    expect(classifyClickHouseError(new Error('socket hang up'))).toBe('unavailable');
    expect(
      classifyClickHouseError(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    ).toBe('unavailable');
    expect(
      classifyClickHouseError(
        Object.assign(new Error('fetch failed'), {
          cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
        }),
      ),
    ).toBe('unavailable');
    for (const code of [159, 160, 241, 396]) {
      expect(classifyClickHouseError(Object.assign(new Error('ClickHouse limit'), { code }))).toBe(
        'limit_exceeded',
      );
    }
    expect(classifyClickHouseError(Object.assign(new Error('syntax error'), { code: '62' }))).toBe(
      'server_error',
    );
  });
});
