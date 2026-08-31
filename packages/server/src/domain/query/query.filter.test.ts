import { describe, expect, it } from 'vitest';

import { configuredLimits } from '../../config/limits.js';
import type { Condition } from './types.js';
import { buildFilterSql } from './filter.js';
import { fields, fieldsWithFloat, fieldsWithInteger } from './query.fixtures.js';
import { expectInvalidQuery } from './query.test-helpers.js';

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

  it.each([
    [{ field: 'score', op: 'eq', value: 0 }, null, null],
    [{ field: 'score', op: 'neq', value: 12.5 }, null, null],
    [{ field: 'score', op: 'in', value: [0, 12.5] }, null, null],
    [{ field: 'score', op: 'not_in', value: [0, 12.5] }, null, null],
    [{ field: 'score', op: 'gt', value: -1 }, '`score` > {p0:Float64}', { p0: -1 }],
    [{ field: 'score', op: 'gte', value: 0 }, '`score` >= {p0:Float64}', { p0: 0 }],
    [{ field: 'score', op: 'lt', value: 10 }, '`score` < {p0:Float64}', { p0: 10 }],
    [{ field: 'score', op: 'lte', value: 10 }, '`score` <= {p0:Float64}', { p0: 10 }],
    [{ field: 'score', op: 'is_null' }, '`score` IS NULL', {}],
    [{ field: 'score', op: 'is_not_null' }, '`score` IS NOT NULL', {}],
  ] as const)(
    'derives float operator support from the V4 capability matrix for %#',
    (condition, sql, params) => {
      if (sql === null) {
        expectInvalidQuery(() =>
          buildFilterSql(condition as Condition, fieldsWithFloat, configuredLimits.query),
        );
        return;
      }
      expect(
        buildFilterSql(condition as Condition, fieldsWithFloat, configuredLimits.query),
      ).toEqual({ sql, params });
    },
  );

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

  it('includes NULL for value negation but excludes it from integer range comparisons', () => {
    for (const condition of [
      { field: 'retry_count', op: 'neq', value: 1 },
      { field: 'retry_count', op: 'not_in', value: [1] },
    ] as Condition[]) {
      expect(buildFilterSql(condition, fieldsWithInteger, configuredLimits.query).sql).toContain(
        '`retry_count` IS NULL OR',
      );
    }
    for (const condition of [
      { field: 'retry_count', op: 'lt', value: 1 },
      { field: 'retry_count', op: 'lte', value: 1 },
    ] as Condition[]) {
      expect(
        buildFilterSql(condition, fieldsWithInteger, configuredLimits.query).sql,
      ).not.toContain('IS NULL');
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
        { field: 'retry_count', op: 'in', value: Array.from({ length: 33 }, () => 1) },
        fieldsWithInteger,
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
    for (const condition of [
      { field: 'score', op: 'contains', value: '1' },
      { field: 'score', op: 'eq', value: 1 },
      { field: 'score', op: 'gte', value: Number.POSITIVE_INFINITY },
    ] as Condition[]) {
      expectInvalidQuery(() => buildFilterSql(condition, fieldsWithFloat, configuredLimits.query));
    }
  });
});
