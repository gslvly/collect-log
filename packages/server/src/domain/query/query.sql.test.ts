import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { configuredLimits } from '../../config/limits.js';
import { AppError } from '../../errors.js';
import { FIELD_MEASURES, fieldTypesResponse } from '../field-types.js';
import type { ActiveField, TableDefinition } from '../tables/types.js';
import { encodeCursor } from './cursor.js';
import { buildFilterSql } from './filter.js';
import {
  definition,
  fieldsWithDatetime,
  fieldsWithFloat,
  fieldsWithNumbers,
} from './query.fixtures.js';
import { expectInvalidQuery } from './query.test-helpers.js';
import { QUERY_OUTPUT_SETTINGS } from './routes.js';
import {
  buildDetailStatement,
  buildExportStatement,
  buildNullAxisRowsStatement,
  buildRowCountStatement,
  buildStatisticsStatement,
} from './sql.js';
import type { StatisticsInput } from './types.js';

describe('query SQL generation', () => {
  const range = { start: 1_777_777_000_000, end: 1_777_778_000_000 };
  const emptyFilter = { sql: '', params: {} };

  it('pins JSON integers to numbers and every DateTime output to ISO 8601 UTC', () => {
    expect(QUERY_OUTPUT_SETTINGS).toEqual({
      output_format_json_quote_64bit_integers: 0,
      date_time_output_format: 'iso',
    });
  });

  it('expands explicit current columns, uses tuple keyset pagination, and never uses FINAL', () => {
    const base = buildDetailStatement(
      definition,
      { range, includeFields: [], limit: 10, order: 'desc' },
      emptyFilter,
    );
    const withCursor = buildDetailStatement(
      definition,
      {
        range,
        includeFields: [],
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
      buildDetailStatement(
        definition,
        { range, includeFields: [], limit: 10, order: 'desc' },
        emptyFilter,
      ).query,
      buildDetailStatement(
        definition,
        {
          range,
          includeFields: [],
          limit: 10,
          order: 'desc',
          cursor: encodeCursor({
            at: range.start,
            id: randomUUID(),
            fp: buildDetailStatement(
              definition,
              { range, includeFields: [], limit: 10, order: 'desc' },
              emptyFilter,
            ).fingerprint,
          }),
        },
        emptyFilter,
      ).query,
      buildStatisticsStatement(
        definition,
        { range, tz: 'UTC', measure: { fn: 'count' } },
        emptyFilter,
      ).query,
      // WITH FILL 的 FROM / TO 也是 DateTime64 参数，同样不能漏掉 'UTC'。
      buildStatisticsStatement(
        definition,
        {
          range,
          tz: 'UTC',
          dimension: { kind: 'time', axis: '_occurred_at', granularity: 'day' },
          measure: { fn: 'count' },
        },
        emptyFilter,
      ).query,
      buildExportStatement(
        definition,
        { range, includeFields: [], order: 'asc' },
        emptyFilter,
        1_000_000,
      ).query,
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
      ...(
        [
          { range, tz: 'UTC', measure: { fn: 'count' } },
          {
            range,
            tz: 'UTC',
            dimension: { kind: 'time', axis: '_occurred_at', granularity: 'day' },
            measure: { fn: 'count' },
          },
          {
            range,
            tz: 'UTC',
            dimension: { kind: 'field', field: 'event_name', limit: 50 },
            measure: { fn: 'count' },
          },
          { range, tz: 'UTC', measure: { fn: 'unique', field: 'event_name' } },
        ] satisfies StatisticsInput[]
      ).map((input) => buildStatisticsStatement(definition, input, emptyFilter)),
      buildExportStatement(
        definition,
        { range, includeFields: [], order: 'asc' },
        emptyFilter,
        1_000_000,
      ),
      buildRowCountStatement(definition),
    ];
    for (const statement of statements) {
      expect(statement.query).not.toMatch(/\bFINAL\b/i);
    }
  });

  // DESIGN 9.4.3 无维度：单值 + 始终带 rows 列。
  it('builds the dimensionless statement with the aggregate and a rows column', () => {
    const definitionWithFloat: TableDefinition = { ...definition, fields: fieldsWithFloat };
    const filter = buildFilterSql(
      { field: 'score', op: 'gte', value: 10.5 },
      fieldsWithFloat,
      configuredLimits.query,
    );
    const statement = buildStatisticsStatement(
      definitionWithFloat,
      {
        range,
        tz: 'UTC',
        filter: { field: 'score', op: 'gte', value: 10.5 },
        measure: { fn: 'sum', field: 'score' },
      },
      filter,
      fieldsWithFloat,
    );
    expect(statement.query).toContain('SELECT sum(`score`) AS value, count() AS rows');
    expect(statement.query).toContain('`score` >= {p0:Float64}');
    expect(statement.query).not.toMatch(/GROUP BY/);
    expect(statement.params).toMatchObject({ p0: 10.5 });
  });

  // DESIGN 9.4.3 第二条：空桶补零只在 axis = _occurred_at 时做；
  // 第四条：业务时间轴要补一条 IS NOT NULL。
  it('fills empty buckets only for the _occurred_at axis and guards a business time axis', () => {
    const definitionWithDatetime: TableDefinition = { ...definition, fields: fieldsWithDatetime };
    const occurredAt = buildStatisticsStatement(
      definitionWithDatetime,
      {
        range,
        tz: 'Asia/Shanghai',
        dimension: { kind: 'time', axis: '_occurred_at', granularity: 'hour' },
        measure: { fn: 'count' },
      },
      emptyFilter,
      fieldsWithDatetime,
    );
    expect(occurredAt.query).toContain('toStartOfHour(`_occurred_at`, {tz:String}) AS bucket');
    expect(occurredAt.query).toContain('WITH TOTALS');
    expect(occurredAt.query).toContain(
      "WITH FILL FROM toStartOfHour({start:DateTime64(3, 'UTC')}, {tz:String})",
    );
    expect(occurredAt.query).toContain('STEP INTERVAL 1 HOUR');
    expect(occurredAt.query).not.toContain('IS NOT NULL');
    expect(occurredAt.params).toMatchObject({ tz: 'Asia/Shanghai' });
    expect(
      buildNullAxisRowsStatement(
        definitionWithDatetime,
        {
          range,
          tz: 'UTC',
          dimension: { kind: 'time', axis: '_occurred_at', granularity: 'hour' },
          measure: { fn: 'count' },
        },
        emptyFilter,
        fieldsWithDatetime,
      ),
    ).toBeNull();

    const businessAxis: StatisticsInput = {
      range,
      tz: 'UTC',
      dimension: { kind: 'time', axis: 'business_at', granularity: 'minute' },
      measure: { fn: 'count' },
    };
    const business = buildStatisticsStatement(
      definitionWithDatetime,
      businessAxis,
      emptyFilter,
      fieldsWithDatetime,
    );
    expect(business.query).toContain('toStartOfMinute(`business_at`) AS bucket');
    expect(business.query).toContain('`business_at` IS NOT NULL');
    expect(business.query).not.toContain('WITH FILL');
    const nullAxis = buildNullAxisRowsStatement(
      definitionWithDatetime,
      businessAxis,
      emptyFilter,
      fieldsWithDatetime,
    );
    expect(nullAxis?.query).toContain('`business_at` IS NULL');
  });

  // DESIGN 9.4.3 第一条 + 9.4.4：WITH TOTALS 拿总计，LIMIT n + 1 探测截断，
  // 且分组维度不排除 NULL —— key: null 那一档必须作为正常结果返回。
  it('groups a field dimension with WITH TOTALS, keeps the null group, and probes with limit + 1', () => {
    const statement = buildStatisticsStatement(
      definition,
      {
        range,
        tz: 'UTC',
        dimension: { kind: 'field', field: 'event_name', limit: 7 },
        measure: { fn: 'count' },
      },
      emptyFilter,
    );
    expect(statement.query).toContain('SELECT `event_name` AS key');
    expect(statement.query).toContain('count() AS value');
    expect(statement.query).toContain('count() AS rows');
    expect(statement.query).toContain('GROUP BY key\n    WITH TOTALS');
    expect(statement.query).toContain('ORDER BY value DESC, key ASC');
    expect(statement.query).toContain('LIMIT {group_limit:UInt32}');
    expect(statement.query).not.toContain('IS NOT NULL');
    expect(statement.params).toMatchObject({ group_limit: 8 });
  });

  // DESIGN 17.3：field-types 下发的 measures 必须与统计侧实际放行的完全一致，
  // 逐类型逐指标对拍，这是防前后端漂移的唯一验收点。
  it('matches the field-types measures list against what statistics actually accepts', () => {
    for (const definitionForType of fieldTypesResponse.types) {
      const field: ActiveField = {
        key: 'probe_field',
        label: 'Probe',
        type: definitionForType.type,
        required: false,
        description: '',
        activeOptions: new Map(),
        schemaVersion: 3,
      };
      const probeFields = [field];
      const probeDefinition: TableDefinition = { ...definition, fields: probeFields };
      for (const fn of FIELD_MEASURES) {
        const accepted = (() => {
          try {
            buildStatisticsStatement(
              probeDefinition,
              { range, tz: 'UTC', measure: { fn, field: 'probe_field' } },
              emptyFilter,
              probeFields,
            );
            return true;
          } catch {
            return false;
          }
        })();
        expect(
          accepted,
          `${definitionForType.type} / ${fn} drifted between field-types and statistics`,
        ).toBe(definitionForType.measures.includes(fn));
      }
    }
  });

  it('emits the DESIGN 9.4.2 aggregate expression for every measure', () => {
    const definitionWithNumbers: TableDefinition = { ...definition, fields: fieldsWithNumbers };
    const expressions: Array<[StatisticsInput['measure'], string]> = [
      [{ fn: 'count' }, 'count() AS value'],
      [{ fn: 'unique', field: 'retry_count' }, 'uniqExact(`retry_count`) AS value'],
      [{ fn: 'sum', field: 'score' }, 'sum(`score`) AS value'],
      [{ fn: 'avg', field: 'score' }, 'avg(`score`) AS value'],
      [{ fn: 'min', field: 'score' }, 'min(`score`) AS value'],
      [{ fn: 'max', field: 'score' }, 'max(`score`) AS value'],
      [{ fn: 'p50', field: 'score' }, 'quantile(0.5)(`score`) AS value'],
      [{ fn: 'p90', field: 'score' }, 'quantile(0.9)(`score`) AS value'],
      [{ fn: 'p99', field: 'score' }, 'quantile(0.99)(`score`) AS value'],
    ];
    for (const [measure, expected] of expressions) {
      const statement = buildStatisticsStatement(
        definitionWithNumbers,
        {
          range,
          tz: 'UTC',
          dimension: { kind: 'field', field: 'event_name', limit: 5 },
          measure,
        },
        emptyFilter,
        fieldsWithNumbers,
      );
      expect(statement.query).toContain(expected);
    }
  });

  // DESIGN 9.4.2：能力不匹配返回 INVALID_QUERY，message 指出是哪个字段的哪种类型不支持哪个 fn。
  it('rejects every capability mismatch on both axes with a self-explaining message', () => {
    const definitionWithNumbers: TableDefinition = { ...definition, fields: fieldsWithNumbers };
    const build = (input: StatisticsInput) =>
      buildStatisticsStatement(definitionWithNumbers, input, emptyFilter, fieldsWithNumbers);

    try {
      build({ range, tz: 'UTC', measure: { fn: 'sum', field: 'event_name' } });
      throw new Error('Expected INVALID_QUERY');
    } catch (error) {
      expect((error as AppError).code).toBe('INVALID_QUERY');
      expect((error as AppError).message).toBe(
        'Field "event_name" of type string does not support measure "sum"',
      );
    }

    for (const input of [
      // float 没有 uniquable / groupable，boolean 没有 summable。
      { range, tz: 'UTC', measure: { fn: 'unique', field: 'score' } },
      { range, tz: 'UTC', measure: { fn: 'avg', field: 'is_success' } },
      {
        range,
        tz: 'UTC',
        dimension: { kind: 'field', field: 'score', limit: 5 },
        measure: { fn: 'count' },
      },
      // datetime 没有 groupable，走 timeAxis。
      {
        range,
        tz: 'UTC',
        dimension: { kind: 'field', field: 'business_at', limit: 5 },
        measure: { fn: 'count' },
      },
      // 非 datetime 字段与非 _occurred_at 的系统列都不能当时间轴。
      {
        range,
        tz: 'UTC',
        dimension: { kind: 'time', axis: 'event_name', granularity: 'day' },
        measure: { fn: 'count' },
      },
      {
        range,
        tz: 'UTC',
        dimension: { kind: 'time', axis: '_received_at', granularity: 'day' },
        measure: { fn: 'count' },
      },
      // 未知字段。
      { range, tz: 'UTC', measure: { fn: 'sum', field: 'missing_field' } },
      {
        range,
        tz: 'UTC',
        dimension: { kind: 'field', field: 'missing_field', limit: 5 },
        measure: { fn: 'count' },
      },
    ] satisfies StatisticsInput[]) {
      expectInvalidQuery(() => build(input));
    }
  });
});
