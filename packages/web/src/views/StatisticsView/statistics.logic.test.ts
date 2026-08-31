import { describe, expect, it } from 'vitest';

import type { FieldTypesResponse } from '../../api/field-types.js';
import type { StatisticsResponse } from '../../api/query.js';
import type { CollectionField, FieldStatus, FieldType } from '../../api/tables.js';
import {
  DENOMINATOR_NOTICE,
  HIGH_CARDINALITY_NOTICE,
  buildChartModel,
  buildChartOption,
  buildStatisticsInput,
  createStatisticsDraft,
  formatRowKey,
  formatShare,
  getGroupableFieldOptions,
  getMeasureFieldOptions,
  getMeasureOptions,
  getTimeAxisOptions,
  getTruncationNotice,
  measureRequiresField,
  needsDenominatorNotice,
  validateGranularityRange,
  type StatisticsDraft,
} from './statistics.logic.js';

function field(
  key: string,
  type: FieldType,
  status: FieldStatus = 'active',
  options: CollectionField['options'] = [],
): CollectionField {
  return {
    key,
    label: `${key} 标签`,
    type,
    required: false,
    description: '',
    options,
    status,
    renamedTo: '',
    schemaVersion: 1,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
  };
}

const fields = [
  field('event_name', 'string'),
  field('channel', 'enum', 'active', [
    { value: 'sms', label: '短信', status: 'active' },
    { value: 'legacy', label: '旧渠道', status: 'disabled' },
  ]),
  field('is_success', 'boolean'),
  field('retry_count', 'integer'),
  field('score', 'float'),
  field('business_at', 'datetime'),
  field('legacy_name', 'string', 'deprecated'),
  field('old_name', 'string', 'renamed'),
];

// 与服务端 GET /api/admin/field-types 的响应同形（5.4.2 的矩阵）。
const fieldTypes: FieldTypesResponse = {
  types: [
    {
      type: 'string',
      label: '文本',
      capabilities: ['equatable', 'enumerable', 'textual', 'groupable', 'uniquable'],
      operators: ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null'],
      measures: ['unique'],
    },
    {
      type: 'enum',
      label: '枚举',
      capabilities: ['equatable', 'enumerable', 'groupable', 'uniquable'],
      operators: ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null'],
      measures: ['unique'],
    },
    {
      type: 'boolean',
      label: '布尔',
      capabilities: ['equatable', 'groupable'],
      operators: ['eq', 'neq', 'is_null', 'is_not_null'],
      measures: [],
    },
    {
      type: 'integer',
      label: '整数',
      capabilities: ['equatable', 'enumerable', 'ordered', 'groupable', 'uniquable', 'summable'],
      operators: ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'is_null', 'is_not_null'],
      measures: ['unique', 'min', 'max', 'sum', 'avg', 'p50', 'p90', 'p99'],
    },
    {
      type: 'float',
      label: '小数',
      capabilities: ['ordered', 'summable'],
      operators: ['gt', 'gte', 'lt', 'lte', 'is_null', 'is_not_null'],
      measures: ['min', 'max', 'sum', 'avg', 'p50', 'p90', 'p99'],
    },
    {
      type: 'datetime',
      label: '时间',
      capabilities: ['ordered', 'timeAxis'],
      operators: ['gt', 'gte', 'lt', 'lte', 'is_null', 'is_not_null'],
      measures: ['min', 'max'],
    },
  ],
  operators: [{ op: 'eq', label: '等于', arity: 'one' }],
  measures: [
    { fn: 'count', label: '记录数' },
    { fn: 'unique', label: '去重计数' },
    { fn: 'min', label: '最小值' },
    { fn: 'max', label: '最大值' },
    { fn: 'sum', label: '合计' },
    { fn: 'avg', label: '平均值' },
    { fn: 'p50', label: 'P50' },
    { fn: 'p90', label: 'P90' },
    { fn: 'p99', label: 'P99' },
  ],
  limits: {
    maxStringLength: 4_096,
    datetimeMinMs: 0,
    datetimeMaxMs: 4_102_444_800_000,
    maxEnumOptions: 200,
    maxOptionValueBytes: 64,
    maxOptionLabelBytes: 128,
    maxConditions: 32,
    maxNestingDepth: 4,
    maxRangeDays: 92,
    defaultGroupLimit: 50,
    maxGroupLimit: 1_000,
  },
};

const range = {
  start: Date.parse('2026-08-01T00:00:00.000Z'),
  end: Date.parse('2026-08-02T00:00:00.000Z'),
};

function draftWith(overrides: Partial<StatisticsDraft>): StatisticsDraft {
  return { ...createStatisticsDraft(), ...overrides };
}

function build(draft: StatisticsDraft, overrides: { range?: typeof range | null } = {}) {
  return buildStatisticsInput(draft, {
    range: overrides.range === undefined ? range : overrides.range,
    tz: 'Asia/Shanghai',
    fields,
    fieldTypes,
  });
}

describe('statistics axis options derived from the served matrix', () => {
  // DESIGN 10.6：维度下拉只列具备 groupable 的字段；float / datetime 不在其中。
  it('lists only groupable fields as dimensions and flags string high cardinality', () => {
    expect(getGroupableFieldOptions(fields, fieldTypes).map((option) => option.key)).toEqual([
      'event_name',
      'channel',
      'is_success',
      'retry_count',
      'legacy_name',
    ]);
    const stringOption = getGroupableFieldOptions(fields, fieldTypes).find(
      (option) => option.key === 'event_name',
    );
    expect(stringOption?.highCardinality).toBe(true);
    expect(
      getGroupableFieldOptions(fields, fieldTypes).find((option) => option.key === 'channel')
        ?.highCardinality,
    ).toBe(false);
    expect(
      getGroupableFieldOptions(fields, fieldTypes).find((option) => option.key === 'legacy_name')
        ?.deprecated,
    ).toBe(true);
    expect(HIGH_CARDINALITY_NOTICE).toContain('高基数');
    // 矩阵未加载时不猜测，直接给空列表。
    expect(getGroupableFieldOptions(fields, null)).toEqual([]);
  });

  // DESIGN 9.4.1：axis 取 _occurred_at 或任意具备 timeAxis 能力的字段。
  it('offers _occurred_at plus every timeAxis field', () => {
    expect(getTimeAxisOptions(fields, fieldTypes).map((option) => option.key)).toEqual([
      '_occurred_at',
      'business_at',
    ]);
    expect(getTimeAxisOptions(fields, fieldTypes)[0]?.occurredAt).toBe(true);
  });

  // DESIGN 10.6：字段列表按该 fn 需要的能力过滤（选了 sum 就只列 integer / float）。
  it('filters measure fields by the capability that the measure needs', () => {
    expect(getMeasureFieldOptions('sum', fields, fieldTypes).map((option) => option.key)).toEqual([
      'retry_count',
      'score',
    ]);
    expect(
      getMeasureFieldOptions('unique', fields, fieldTypes).map((option) => option.key),
    ).toEqual(['event_name', 'channel', 'retry_count', 'legacy_name']);
    expect(getMeasureFieldOptions('min', fields, fieldTypes).map((option) => option.key)).toEqual([
      'retry_count',
      'score',
      'business_at',
    ]);
    expect(getMeasureFieldOptions('count', fields, fieldTypes)).toEqual([]);
  });

  // count 是唯一不带字段的指标，这条判断完全由接口数据推出。
  it('derives which measures need a field from the response instead of a local table', () => {
    expect(measureRequiresField('count', fieldTypes)).toBe(false);
    for (const fn of ['unique', 'sum', 'avg', 'min', 'max', 'p50', 'p90', 'p99'] as const) {
      expect(measureRequiresField(fn, fieldTypes)).toBe(true);
    }
    expect(getMeasureOptions(fieldTypes)).toContainEqual({
      fn: 'count',
      label: '记录数',
      requiresField: false,
    });
    expect(getMeasureOptions(null)).toEqual([]);
  });
});

describe('statistics request assembly', () => {
  it('builds all three dimension shapes', () => {
    expect(build(draftWith({}))).toEqual({
      valid: true,
      input: { range, tz: 'Asia/Shanghai', measure: { fn: 'count' } },
    });

    expect(
      build(draftWith({ dimensionKind: 'time', axis: 'business_at', granularity: 'hour' })).input,
    ).toEqual({
      range,
      tz: 'Asia/Shanghai',
      dimension: { kind: 'time', axis: 'business_at', granularity: 'hour' },
      measure: { fn: 'count' },
    });

    // groupLimit 留空时不下发 limit，交给服务端的 defaultGroupLimit。
    expect(build(draftWith({ dimensionKind: 'field', dimensionField: 'channel' })).input).toEqual({
      range,
      tz: 'Asia/Shanghai',
      dimension: { kind: 'field', field: 'channel' },
      measure: { fn: 'count' },
    });
    expect(
      build(draftWith({ dimensionKind: 'field', dimensionField: 'channel', groupLimit: 10 })).input,
    ).toEqual({
      range,
      tz: 'Asia/Shanghai',
      dimension: { kind: 'field', field: 'channel', limit: 10 },
      measure: { fn: 'count' },
    });

    expect(build(draftWith({ fn: 'sum', measureField: 'score' })).input).toEqual({
      range,
      tz: 'Asia/Shanghai',
      measure: { fn: 'sum', field: 'score' },
    });
  });

  it('refuses every combination the server would reject', () => {
    // 能力不匹配的 fn / 字段组合，前端必须先拦下，不能让用户点了才收 INVALID_QUERY。
    expect(build(draftWith({ fn: 'sum', measureField: 'event_name' }))).toMatchObject({
      valid: false,
      message: '字段 event_name 不支持指标 sum',
    });
    expect(build(draftWith({ fn: 'sum' }))).toMatchObject({
      valid: false,
      message: '请为该指标选择字段',
    });
    expect(build(draftWith({ dimensionKind: 'field', dimensionField: 'score' }))).toMatchObject({
      valid: false,
      message: '字段 score 不能作为分组维度',
    });
    expect(
      build(draftWith({ dimensionKind: 'time', axis: 'event_name', granularity: 'day' })),
    ).toMatchObject({ valid: false, message: '字段 event_name 不能作为时间轴' });
    expect(
      build(draftWith({ dimensionKind: 'field', dimensionField: 'channel', groupLimit: 1_001 })),
    ).toMatchObject({ valid: false, message: '分组数量必须在 1 到 1000 之间' });
    expect(build(draftWith({}), { range: null })).toMatchObject({
      valid: false,
      message: '请选择时间范围',
    });
    expect(
      buildStatisticsInput(draftWith({}), {
        range,
        tz: 'UTC',
        fields,
        fieldTypes: null,
      }),
    ).toMatchObject({ valid: false, message: '字段类型能力尚未加载' });
  });

  // 附录 A：minute ≤ 2 天、hour ≤ 31 天，day 不额外收紧。
  it('enforces the per-granularity range ceilings', () => {
    const day = 86_400_000;
    expect(validateGranularityRange({ start: 0, end: 2 * day }, 'minute')).toBeUndefined();
    expect(validateGranularityRange({ start: 0, end: 2 * day + 1 }, 'minute')).toContain('2 天');
    expect(validateGranularityRange({ start: 0, end: 31 * day }, 'hour')).toBeUndefined();
    expect(validateGranularityRange({ start: 0, end: 31 * day + 1 }, 'hour')).toContain('31 天');
    expect(validateGranularityRange({ start: 0, end: 92 * day }, 'day')).toBeUndefined();
    expect(
      build(draftWith({ dimensionKind: 'time', granularity: 'minute' }), {
        range: { start: 0, end: 3 * day },
      }),
    ).toMatchObject({ valid: false });
  });
});

describe('statistics result rendering', () => {
  // DESIGN 9.4.4：key 为 null 的那一档是「未提交该字段」，enum 按 options 的 label 渲染，
  // 含已停用选项。
  it('renders every key kind, including the null group and disabled enum options', () => {
    const channel = fields.find((candidate) => candidate.key === 'channel');
    const context = {
      dimension: 'field' as const,
      ...(channel === undefined ? {} : { field: channel }),
      timeZone: 'Asia/Shanghai',
    };
    expect(formatRowKey(null, context)).toBe('（未提交）');
    expect(formatRowKey('', context)).toBe('（空字符串）');
    expect(formatRowKey('sms', context)).toBe('短信');
    expect(formatRowKey('legacy', context)).toBe('旧渠道（已停用）');
    expect(formatRowKey('never_registered', context)).toBe('never_registered');
    expect(formatRowKey(true, { dimension: 'field', timeZone: 'UTC' })).toBe('是');
    expect(
      formatRowKey('2026-08-27T00:00:00.000Z', { dimension: 'time', timeZone: 'Asia/Shanghai' }),
    ).toContain('2026');
    expect(formatShare(0.625)).toBe('62.5%');
    expect(formatShare(undefined)).toBe('');
  });

  // DESIGN 10.6：avg / 分位数旁必须写明分母口径。
  it('marks exactly the measures whose denominator is the non-null row count', () => {
    for (const fn of ['avg', 'p50', 'p90', 'p99'] as const) {
      expect(needsDenominatorNotice(fn)).toBe(true);
    }
    for (const fn of ['count', 'unique', 'sum', 'min', 'max'] as const) {
      expect(needsDenominatorNotice(fn)).toBe(false);
    }
    expect(DENOMINATOR_NOTICE).toContain('非空的行数');
  });

  // DESIGN 10.6：others 有则画成图例最后一档，truncated 要给「仅显示前 N 项」。
  it('appends others as the last chart category and surfaces the truncation notice', () => {
    const response: StatisticsResponse = {
      dimension: 'field',
      measure: { fn: 'count' },
      rows: [
        { key: 'sms', value: 8, rows: 8, share: 0.8 },
        { key: null, value: 1, rows: 1, share: 0.1 },
      ],
      totals: { value: 10, rows: 10 },
      others: { value: 1 },
      truncated: true,
    };
    const model = buildChartModel(response, { measureLabel: '记录数', timeZone: 'UTC' });
    expect(model.kind).toBe('bar');
    expect(model.points.map((point) => point.label)).toEqual(['sms', '（未提交）', '其它']);
    expect(model.points.at(-1)).toMatchObject({ value: 1, others: true });
    expect(getTruncationNotice(response)).toBe('分组数超过上限，仅显示前 2 项');
    expect(getTruncationNotice({ ...response, truncated: false })).toBeUndefined();

    const option = buildChartOption(model);
    expect(option.xAxis).toMatchObject({ data: ['sms', '（未提交）', '其它'] });
  });

  it('draws the time dimension as a line and keeps filled buckets as null gaps', () => {
    const response: StatisticsResponse = {
      dimension: 'time',
      measure: { fn: 'avg', field: 'score' },
      rows: [
        { key: '2026-08-27T00:00:00.000Z', value: null, rows: 0 },
        { key: '2026-08-28T00:00:00.000Z', value: 12.5, rows: 4 },
      ],
      totals: { value: 12.5, rows: 4 },
      truncated: false,
    };
    const model = buildChartModel(response, { measureLabel: '平均值', timeZone: 'UTC' });
    expect(model.kind).toBe('line');
    expect(model.points.map((point) => point.value)).toEqual([null, 12.5]);
    expect(
      buildChartModel({ ...response, dimension: null }, { measureLabel: '', timeZone: 'UTC' }).kind,
    ).toBe('none');
  });
});
