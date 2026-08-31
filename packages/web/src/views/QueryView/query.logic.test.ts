import { describe, expect, it } from 'vitest';

import type { FieldTypesResponse } from '../../api/field-types.js';
import type { CollectionField, CollectionTable, FieldStatus } from '../../api/tables.js';
import {
  buildQueryFilter,
  createDefaultTimeRange,
  createFilterGroup,
  createFilterRule,
  getConditionCount,
  getOperatorOptions,
  getQueryableTables,
  moveColumn,
  parseColumnPreference,
  pickerDateToTimestamp,
  queryInputSignature,
  reconcileColumnPreference,
  resetRuleForField,
  setRuleOperator,
  timestampToPickerDate,
  validateTimeRange,
  type FilterGroupDraft,
  type FilterRuleDraft,
} from './query.logic.js';

function field(
  key: string,
  type: CollectionField['type'],
  status: FieldStatus = 'active',
): CollectionField {
  return {
    key,
    label: key,
    type,
    required: false,
    description: '',
    options: [],
    status,
    renamedTo: '',
    schemaVersion: 1,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
  };
}

const fields = [
  field('event_name', 'string'),
  field('is_success', 'boolean'),
  field('retry_count', 'integer'),
  field('score', 'float'),
  field('business_at', 'datetime'),
  field('legacy_name', 'string', 'deprecated'),
  field('old_name', 'string', 'renamed'),
];

const fieldTypes: FieldTypesResponse = {
  types: [
    {
      type: 'string',
      label: '文本',
      capabilities: ['equatable', 'enumerable', 'textual', 'groupable', 'uniquable'],
      operators: [
        'eq',
        'neq',
        'in',
        'not_in',
        'contains',
        'not_contains',
        'is_empty',
        'is_not_empty',
        'is_null',
        'is_not_null',
      ],
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
  operators: [
    { op: 'eq', label: '等于', arity: 'one' },
    { op: 'neq', label: '不等于', arity: 'one' },
    { op: 'in', label: '属于', arity: 'many' },
    { op: 'not_in', label: '不属于', arity: 'many' },
    { op: 'gt', label: '大于', arity: 'one' },
    { op: 'gte', label: '大于等于', arity: 'one' },
    { op: 'lt', label: '小于', arity: 'one' },
    { op: 'lte', label: '小于等于', arity: 'one' },
    { op: 'contains', label: '包含', arity: 'one' },
    { op: 'not_contains', label: '不包含', arity: 'one' },
    { op: 'is_empty', label: '空字符串', arity: 'none' },
    { op: 'is_not_empty', label: '非空字符串', arity: 'none' },
    { op: 'is_null', label: '未提交', arity: 'none' },
    { op: 'is_not_null', label: '已提交', arity: 'none' },
  ],
  measures: [],
  limits: {
    maxStringLength: 4_096,
    datetimeMinMs: 946_684_800_000,
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

function table(projectId: string, status: CollectionTable['status']): CollectionTable {
  return {
    projectId,
    displayName: projectId,
    description: '',
    status,
    schemaVersion: 1,
    createdBy: 'root',
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
  };
}

describe('query time range logic', () => {
  it('creates the latest 24-hour range and enforces start, end, and the 92-day limit', () => {
    const now = Date.parse('2026-08-29T12:00:00.000Z');
    expect(createDefaultTimeRange(now)).toEqual({ start: now - 86_400_000, end: now });
    const limits = fieldTypes.limits;
    expect(validateTimeRange(null, limits)).toBe('请选择时间范围');
    expect(validateTimeRange({ start: 10, end: 10 }, limits)).toBe('开始时间必须早于结束时间');
    expect(validateTimeRange({ start: 0, end: 92 * 86_400_000 }, limits)).toBeUndefined();
    expect(validateTimeRange({ start: 0, end: 92 * 86_400_000 + 1 }, limits)).toBe(
      '时间跨度不能超过 92 天',
    );
    // 跨度上限来自接口而不是前端常量：改了下发值，提示与判定一起变。
    expect(
      validateTimeRange({ start: 0, end: 8 * 86_400_000 }, { ...limits, maxRangeDays: 7 }),
    ).toBe('时间跨度不能超过 7 天');
    expect(validateTimeRange({ start: 0, end: 86_400_000 }, null)).toBe('查询限额尚未加载');
  });

  it.each([
    ['Asia/Shanghai', '2026-01-15T00:00:00.123Z', [2026, 1, 15, 8, 0, 0, 123]],
    ['America/New_York', '2026-07-15T12:34:56.789Z', [2026, 7, 15, 8, 34, 56, 789]],
  ] as const)('round-trips picker wall time in %s', (timeZone, iso, expectedParts) => {
    const timestamp = Date.parse(iso);
    const pickerDate = timestampToPickerDate(timestamp, timeZone);
    expect([
      pickerDate.getFullYear(),
      pickerDate.getMonth() + 1,
      pickerDate.getDate(),
      pickerDate.getHours(),
      pickerDate.getMinutes(),
      pickerDate.getSeconds(),
      pickerDate.getMilliseconds(),
    ]).toEqual(expectedParts);
    expect(pickerDateToTimestamp(pickerDate, timeZone)).toBe(timestamp);
  });
});

describe('query filter builder', () => {
  it('serializes nested string and boolean conditions with deprecated fields allowed', () => {
    const root = createFilterGroup('and');
    const stringRule: FilterRuleDraft = {
      ...createFilterRule('legacy_name'),
      op: 'in',
      value: ['login', 'logout'],
    };
    const nested = createFilterGroup('or');
    const booleanRule = createFilterRule('is_success');
    booleanRule.value = false;
    const nullRule = createFilterRule('event_name');
    nullRule.op = 'is_null';
    delete nullRule.value;
    nested.conditions.push(booleanRule, nullRule);
    root.conditions.push(stringRule, nested);

    expect(buildQueryFilter(root, fields, fieldTypes)).toEqual({
      valid: true,
      count: 4,
      filter: {
        op: 'and',
        conditions: [
          { field: 'legacy_name', op: 'in', value: ['login', 'logout'] },
          {
            op: 'or',
            conditions: [
              { field: 'is_success', op: 'eq', value: false },
              { field: 'event_name', op: 'is_null' },
            ],
          },
        ],
      },
    });
  });

  it('counts every in/not_in value and takes the condition ceiling from the served limits', () => {
    const root = createFilterGroup();
    root.conditions.push({
      ...createFilterRule('event_name'),
      op: 'not_in',
      value: Array.from({ length: 33 }, (_, index) => String(index)),
    });
    expect(getConditionCount(root)).toBe(33);
    expect(buildQueryFilter(root, fields, fieldTypes)).toMatchObject({
      valid: false,
      count: 33,
      message: '条件数量不能超过 32',
    });
    // 服务端调大 maxConditions 后前端必须跟着放行，不能拦下服务端本可接受的条件。
    expect(
      buildQueryFilter(root, fields, {
        ...fieldTypes,
        limits: { ...fieldTypes.limits, maxConditions: 64 },
      }),
    ).toMatchObject({ valid: true, count: 33 });
    // 调小则连提示文案一起变。
    expect(
      buildQueryFilter(root, fields, {
        ...fieldTypes,
        limits: { ...fieldTypes.limits, maxConditions: 8 },
      }),
    ).toMatchObject({ valid: false, message: '条件数量不能超过 8' });
  });

  it('uses the downloaded matrix for operator rendering, defaults, and validation', () => {
    expect(getOperatorOptions('score', fields, fieldTypes).map((option) => option.op)).toEqual([
      'gt',
      'gte',
      'lt',
      'lte',
      'is_null',
      'is_not_null',
    ]);

    const cases: Array<{
      op: FilterRuleDraft['op'];
      value?: number | number[];
    }> = [
      { op: 'gt', value: -1 },
      { op: 'gte', value: 0 },
      { op: 'lt', value: 100 },
      { op: 'lte', value: 100.5 },
      { op: 'is_null' },
      { op: 'is_not_null' },
    ];

    for (const testCase of cases) {
      const root = createFilterGroup();
      const rule = createFilterRule('score');
      rule.op = testCase.op;
      if (testCase.value === undefined) {
        delete rule.value;
      } else {
        rule.value = testCase.value;
      }
      root.conditions.push(rule);
      const built = buildQueryFilter(root, fields, fieldTypes);
      expect(built).toMatchObject({ valid: true, count: Array.isArray(testCase.value) ? 2 : 1 });
      expect(built.filter).toEqual({
        op: 'and',
        conditions: [
          {
            field: 'score',
            op: testCase.op,
            ...(testCase.value === undefined ? {} : { value: testCase.value }),
          },
        ],
      });
    }

    const rejectedFloatEquality = createFilterGroup();
    rejectedFloatEquality.conditions.push({
      ...createFilterRule('score'),
      op: 'eq',
      value: 0,
    });
    expect(buildQueryFilter(rejectedFloatEquality, fields, fieldTypes)).toMatchObject({
      valid: false,
      message: 'float 字段 score 不支持操作符 eq',
    });

    const rule = createFilterRule('score');
    resetRuleForField(rule, fields, fieldTypes);
    expect(rule).toMatchObject({ op: 'gt', value: 0 });
    const score = fields.find((candidate) => candidate.key === 'score');
    if (score === undefined) {
      throw new Error('score fixture is missing');
    }
    setRuleOperator(rule, 'is_null', score, fieldTypes);
    expect(rule).not.toHaveProperty('value');

    const integerMembership = createFilterGroup();
    integerMembership.conditions.push({
      ...createFilterRule('retry_count'),
      op: 'in',
      value: [0, 2],
    });
    expect(buildQueryFilter(integerMembership, fields, fieldTypes)).toMatchObject({ valid: true });

    const emptyString = createFilterGroup();
    emptyString.conditions.push({
      ...createFilterRule('event_name'),
      op: 'is_empty',
    });
    expect(buildQueryFilter(emptyString, fields, fieldTypes).filter).toEqual({
      op: 'and',
      conditions: [{ field: 'event_name', op: 'is_empty' }],
    });
  });

  it('keeps integer values safe while allowing every finite Float64 value', () => {
    for (const value of [Number.MAX_SAFE_INTEGER + 1, -(Number.MAX_SAFE_INTEGER + 1)]) {
      const root = createFilterGroup();
      root.conditions.push({ ...createFilterRule('retry_count'), op: 'gte', value });
      expect(buildQueryFilter(root, fields, fieldTypes)).toMatchObject({
        valid: false,
        message: '字段 retry_count 的条件值不符合 integer 类型要求',
      });
    }

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const root = createFilterGroup();
      root.conditions.push({ ...createFilterRule('score'), op: 'gte', value });
      expect(buildQueryFilter(root, fields, fieldTypes)).toMatchObject({
        valid: false,
        message: '字段 score 的条件值不符合 float 类型要求',
      });
    }

    const finiteFloat = createFilterGroup();
    finiteFloat.conditions.push({
      ...createFilterRule('score'),
      op: 'gte',
      value: Number.MAX_SAFE_INTEGER + 1,
    });
    expect(buildQueryFilter(finiteFloat, fields, fieldTypes)).toMatchObject({ valid: true });

    const membership = createFilterGroup();
    membership.conditions.push({
      ...createFilterRule('retry_count'),
      op: 'in',
      value: [0, Number.MAX_SAFE_INTEGER + 1],
    });
    expect(buildQueryFilter(membership, fields, fieldTypes)).toMatchObject({
      valid: false,
      count: 2,
      message: '字段 retry_count 至少需要一个合法值',
    });
  });

  it('mirrors the server nesting depth and rejects empty nested groups', () => {
    const valid = createFilterGroup();
    const levelTwo = createFilterGroup();
    const levelThree = createFilterGroup();
    levelThree.conditions.push(createFilterRule('event_name'));
    levelTwo.conditions.push(levelThree);
    valid.conditions.push(levelTwo);
    expect(buildQueryFilter(valid, fields, fieldTypes).valid).toBe(true);

    const invalid = createFilterGroup();
    const invalidTwo = createFilterGroup();
    const invalidThree = createFilterGroup();
    const invalidFour = createFilterGroup();
    invalidFour.conditions.push(createFilterRule('event_name'));
    invalidThree.conditions.push(invalidFour);
    invalidTwo.conditions.push(invalidThree);
    invalid.conditions.push(invalidTwo);
    expect(buildQueryFilter(invalid, fields, fieldTypes)).toMatchObject({
      valid: false,
      message: '嵌套深度不能超过 4',
    });
    // 嵌套深度同样来自接口。
    expect(
      buildQueryFilter(valid, fields, {
        ...fieldTypes,
        limits: { ...fieldTypes.limits, maxNestingDepth: 2 },
      }),
    ).toMatchObject({ valid: false, message: '嵌套深度不能超过 2' });

    const emptyNested: FilterGroupDraft = createFilterGroup();
    emptyNested.conditions.push(createFilterGroup());
    expect(buildQueryFilter(emptyNested, fields, fieldTypes)).toMatchObject({
      valid: false,
      message: '条件组不能为空',
    });
  });

  it('rejects tombstones and incomplete membership values before requesting the server', () => {
    const renamed = createFilterGroup();
    renamed.conditions.push(createFilterRule('old_name'));
    expect(buildQueryFilter(renamed, fields, fieldTypes)).toMatchObject({
      valid: false,
      message: '请选择可查询字段',
    });

    const emptyIn = createFilterGroup();
    emptyIn.conditions.push({ ...createFilterRule('event_name'), op: 'in', value: [] });
    expect(buildQueryFilter(emptyIn, fields, fieldTypes)).toMatchObject({
      valid: false,
      message: '字段 event_name 至少需要一个合法值',
    });
  });
});

describe('query table and column preferences', () => {
  it('filters creating and failed tables from the selector', () => {
    expect(
      getQueryableTables([
        table('creating', 'creating'),
        table('active', 'active'),
        table('disabled', 'disabled'),
        table('archived', 'archived'),
        table('failed', 'failed'),
      ]).map((item) => item.projectId),
    ).toEqual(['active', 'disabled', 'archived']);
  });

  it('drops missing remembered columns and appends new columns as visible', () => {
    expect(
      reconcileColumnPreference(['_record_id', 'event_name', 'is_success', 'new_field'], {
        order: ['is_success', 'removed_field', '_record_id'],
        hidden: ['is_success', 'removed_field'],
      }),
    ).toEqual({
      order: ['is_success', '_record_id', 'event_name', 'new_field'],
      hidden: ['is_success'],
    });
    expect(moveColumn(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(parseColumnPreference('{"order":["a","a"],"hidden":["b"]}')).toEqual({
      order: ['a'],
      hidden: ['b'],
    });
    expect(parseColumnPreference('{"order":"a","hidden":[]}')).toBeNull();
  });

  it('normalizes includeFields ordering in the input signature', () => {
    const filter = createFilterGroup();
    const base = {
      projectId: 'prj_example',
      range: { start: 1, end: 2 },
      filter,
      order: 'desc' as const,
      schemaVersion: 1,
    };
    expect(queryInputSignature({ ...base, includeFields: ['z', 'a'] })).toBe(
      queryInputSignature({ ...base, includeFields: ['a', 'z'] }),
    );
  });
});
