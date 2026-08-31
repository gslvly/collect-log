import type { FieldCapability, FieldMeasure, FieldTypesResponse } from '../../api/field-types.js';
import {
  OCCURRED_AT_AXIS,
  type QueryFilter,
  type StatisticsInput,
  type StatisticsResponse,
  type StatisticsRow,
  type TimeRange,
  type TrendGranularity,
} from '../../api/query.js';
import type { CollectionField, FieldType } from '../../api/tables.js';
import { formatUtcIso } from '../../stores/timezone.js';

export { OCCURRED_AT_AXIS };

export type DimensionKind = 'none' | 'time' | 'field';

export interface StatisticsDraft {
  dimensionKind: DimensionKind;
  dimensionField: string;
  axis: string;
  granularity: TrendGranularity;
  /** `null` 表示交给服务端的 `defaultGroupLimit`，前端不复制这个默认值。 */
  groupLimit: number | null;
  fn: FieldMeasure;
  measureField: string;
}

export interface StatisticsFieldOption {
  key: string;
  label: string;
  type: FieldType;
  deprecated: boolean;
  /** DESIGN 10.6 / 5.4.3：`string` 维度要提示高基数分组可能较慢，但不阻止。 */
  highCardinality: boolean;
}

export interface TimeAxisOption {
  key: string;
  label: string;
  occurredAt: boolean;
  deprecated: boolean;
}

export interface MeasureOption {
  fn: FieldMeasure;
  label: string;
  requiresField: boolean;
}

export interface StatisticsBuildResult {
  valid: boolean;
  input?: StatisticsInput;
  message?: string;
}

export const GRANULARITY_LABELS: Readonly<Record<TrendGranularity, string>> = {
  minute: '按分钟',
  hour: '按小时',
  day: '按天',
};

/**
 * 附录 A：`minute` 粒度 ≤ 2 天、`hour` 粒度 ≤ 31 天。
 * 这两个数字跟着粒度走、不提供环境变量，因此不经 `field-types` 下发。
 */
const GRANULARITY_MAX_SPAN_DAYS: Readonly<Record<TrendGranularity, number | null>> = {
  minute: 2,
  hour: 31,
  day: null,
};

const DAY_MS = 86_400_000;

export const HIGH_CARDINALITY_NOTICE = '高基数字段分组可能较慢';

/**
 * DESIGN 9.4.2 / 10.6：聚合一律跳过 NULL，因此 `avg` 与分位数的分母是该字段非空的行数。
 * 少了这句，「平均耗时」会被当成「所有请求的平均耗时」而系统性偏高。
 */
export const DENOMINATOR_NOTICE = '分母是该字段非空的行数，不是命中的总行数';

const DENOMINATOR_MEASURES: ReadonlySet<FieldMeasure> = new Set<FieldMeasure>([
  'avg',
  'p50',
  'p90',
  'p99',
]);

export function needsDenominatorNotice(fn: FieldMeasure): boolean {
  return DENOMINATOR_MEASURES.has(fn);
}

export function createStatisticsDraft(): StatisticsDraft {
  return {
    dimensionKind: 'none',
    dimensionField: '',
    axis: OCCURRED_AT_AXIS,
    granularity: 'day',
    groupLimit: null,
    fn: 'count',
    measureField: '',
  };
}

function queryableFields(fields: readonly CollectionField[]): CollectionField[] {
  return fields.filter((field) => field.status === 'active' || field.status === 'deprecated');
}

function capabilitiesOf(
  type: FieldType,
  fieldTypes: FieldTypesResponse,
): readonly FieldCapability[] {
  return fieldTypes.types.find((candidate) => candidate.type === type)?.capabilities ?? [];
}

function measuresOf(type: FieldType, fieldTypes: FieldTypesResponse): readonly FieldMeasure[] {
  return fieldTypes.types.find((candidate) => candidate.type === type)?.measures ?? [];
}

function toFieldOption(field: CollectionField): StatisticsFieldOption {
  return {
    key: field.key,
    label: field.label === '' ? field.key : field.label,
    type: field.type,
    deprecated: field.status === 'deprecated',
    // DESIGN 5.4.3：基数是类型答不了的问题，`string` 一律提示，但不阻止。
    highCardinality: field.type === 'string',
  };
}

/** DESIGN 10.6：维度下拉只列具备 `groupable` 的字段，能力判断一律读接口。 */
export function getGroupableFieldOptions(
  fields: readonly CollectionField[],
  fieldTypes: FieldTypesResponse | null,
): StatisticsFieldOption[] {
  if (fieldTypes === null) {
    return [];
  }
  return queryableFields(fields)
    .filter((field) => capabilitiesOf(field.type, fieldTypes).includes('groupable'))
    .map(toFieldOption);
}

/** DESIGN 9.4.1：`_occurred_at` 或任意具备 `timeAxis` 能力的字段。 */
export function getTimeAxisOptions(
  fields: readonly CollectionField[],
  fieldTypes: FieldTypesResponse | null,
): TimeAxisOption[] {
  const occurredAt: TimeAxisOption = {
    key: OCCURRED_AT_AXIS,
    label: '上报时间（_occurred_at）',
    occurredAt: true,
    deprecated: false,
  };
  if (fieldTypes === null) {
    return [occurredAt];
  }
  return [
    occurredAt,
    ...queryableFields(fields)
      .filter((field) => capabilitiesOf(field.type, fieldTypes).includes('timeAxis'))
      .map((field) => ({
        key: field.key,
        label: field.label === '' ? field.key : field.label,
        occurredAt: false,
        deprecated: field.status === 'deprecated',
      })),
  ];
}

/**
 * `count` 是唯一不带字段的指标：它出现在接口的 `measures` 列表里，
 * 却不出现在任何类型的 `measures` 中。这个判断因此完全由接口数据推出，前端不写死。
 */
export function measureRequiresField(
  fn: FieldMeasure,
  fieldTypes: FieldTypesResponse | null,
): boolean {
  return fieldTypes !== null && fieldTypes.types.some((type) => type.measures.includes(fn));
}

export function getMeasureOptions(fieldTypes: FieldTypesResponse | null): MeasureOption[] {
  if (fieldTypes === null) {
    return [];
  }
  return fieldTypes.measures.map((measure) => ({
    fn: measure.fn,
    label: measure.label,
    requiresField: measureRequiresField(measure.fn, fieldTypes),
  }));
}

/** DESIGN 10.6：字段列表按该 `fn` 需要的能力过滤（选了 `sum` 就只列 integer / float）。 */
export function getMeasureFieldOptions(
  fn: FieldMeasure,
  fields: readonly CollectionField[],
  fieldTypes: FieldTypesResponse | null,
): StatisticsFieldOption[] {
  if (fieldTypes === null) {
    return [];
  }
  return queryableFields(fields)
    .filter((field) => measuresOf(field.type, fieldTypes).includes(fn))
    .map(toFieldOption);
}

export function validateGranularityRange(
  range: TimeRange,
  granularity: TrendGranularity,
): string | undefined {
  const maxDays = GRANULARITY_MAX_SPAN_DAYS[granularity];
  if (maxDays !== null && range.end - range.start > maxDays * DAY_MS) {
    return `${GRANULARITY_LABELS[granularity]}聚合的时间跨度不能超过 ${maxDays} 天`;
  }
  return undefined;
}

export function buildStatisticsInput(
  draft: StatisticsDraft,
  context: {
    range: TimeRange | null;
    tz: string;
    filter?: QueryFilter | undefined;
    fields: readonly CollectionField[];
    fieldTypes: FieldTypesResponse | null;
  },
): StatisticsBuildResult {
  const { range, fieldTypes } = context;
  if (fieldTypes === null) {
    return { valid: false, message: '字段类型能力尚未加载' };
  }
  if (range === null) {
    return { valid: false, message: '请选择时间范围' };
  }

  const requiresField = measureRequiresField(draft.fn, fieldTypes);
  if (requiresField && draft.measureField === '') {
    return { valid: false, message: '请为该指标选择字段' };
  }
  if (
    requiresField &&
    !getMeasureFieldOptions(draft.fn, context.fields, fieldTypes).some(
      (option) => option.key === draft.measureField,
    )
  ) {
    return { valid: false, message: `字段 ${draft.measureField} 不支持指标 ${draft.fn}` };
  }

  const measure = requiresField ? { fn: draft.fn, field: draft.measureField } : { fn: draft.fn };

  if (draft.dimensionKind === 'time') {
    const axisError = validateGranularityRange(range, draft.granularity);
    if (axisError !== undefined) {
      return { valid: false, message: axisError };
    }
    if (
      !getTimeAxisOptions(context.fields, fieldTypes).some((option) => option.key === draft.axis)
    ) {
      return { valid: false, message: `字段 ${draft.axis} 不能作为时间轴` };
    }
    return {
      valid: true,
      input: {
        range,
        tz: context.tz,
        ...(context.filter === undefined ? {} : { filter: context.filter }),
        dimension: { kind: 'time', axis: draft.axis, granularity: draft.granularity },
        measure,
      },
    };
  }

  if (draft.dimensionKind === 'field') {
    if (draft.dimensionField === '') {
      return { valid: false, message: '请选择分组字段' };
    }
    if (
      !getGroupableFieldOptions(context.fields, fieldTypes).some(
        (option) => option.key === draft.dimensionField,
      )
    ) {
      return { valid: false, message: `字段 ${draft.dimensionField} 不能作为分组维度` };
    }
    if (
      draft.groupLimit !== null &&
      (!Number.isSafeInteger(draft.groupLimit) ||
        draft.groupLimit < 1 ||
        draft.groupLimit > fieldTypes.limits.maxGroupLimit)
    ) {
      return {
        valid: false,
        message: `分组数量必须在 1 到 ${fieldTypes.limits.maxGroupLimit} 之间`,
      };
    }
    return {
      valid: true,
      input: {
        range,
        tz: context.tz,
        ...(context.filter === undefined ? {} : { filter: context.filter }),
        dimension: {
          kind: 'field',
          field: draft.dimensionField,
          ...(draft.groupLimit === null ? {} : { limit: draft.groupLimit }),
        },
        measure,
      },
    };
  }

  return {
    valid: true,
    input: {
      range,
      tz: context.tz,
      ...(context.filter === undefined ? {} : { filter: context.filter }),
      measure,
    },
  };
}

/**
 * DESIGN 9.4.4：`enum` 字段的取值按 `options` 的 `label` 渲染，**含已停用选项** ——
 * 历史数据里还有它们，图例上不能变成裸串。
 */
export function formatRowKey(
  key: StatisticsRow['key'],
  context: {
    dimension: StatisticsResponse['dimension'];
    field?: CollectionField | undefined;
    timeZone: string;
  },
): string {
  if (context.dimension === 'time') {
    return typeof key === 'string'
      ? formatUtcIso(key, context.timeZone, { dateStyle: 'short', timeStyle: 'short' })
      : '';
  }
  if (key === null || key === undefined) {
    return '（未提交）';
  }
  if (key === '') {
    return '（空字符串）';
  }
  if (typeof key === 'boolean') {
    return key ? '是' : '否';
  }
  if (context.field?.type === 'enum' && typeof key === 'string') {
    const option = context.field.options.find((candidate) => candidate.value === key);
    if (option !== undefined) {
      return option.status === 'disabled' ? `${option.label}（已停用）` : option.label;
    }
  }
  return String(key);
}

export function formatMeasureValue(value: StatisticsRow['value']): string {
  if (value === null) {
    return '—';
  }
  if (typeof value === 'string') {
    return value;
  }
  return Number.isInteger(value) ? value.toLocaleString('zh-CN') : value.toLocaleString('zh-CN');
}

export function formatShare(share: number | undefined): string {
  return share === undefined ? '' : `${(share * 100).toFixed(1)}%`;
}

export interface ChartSeriesPoint {
  label: string;
  value: number | null;
  others?: boolean;
}

export interface StatisticsChartModel {
  kind: 'line' | 'bar' | 'none';
  points: ChartSeriesPoint[];
  measureLabel: string;
}

/**
 * DESIGN 10.6：`others` 有则画成图例最后一档，因此它作为最后一个类目参与作图，
 * 而不是被前端悄悄并进某个分组。
 */
export function buildChartModel(
  response: StatisticsResponse,
  context: { measureLabel: string; field?: CollectionField | undefined; timeZone: string },
): StatisticsChartModel {
  if (response.dimension === null) {
    return { kind: 'none', points: [], measureLabel: context.measureLabel };
  }
  const points: ChartSeriesPoint[] = response.rows.map((row) => ({
    label: formatRowKey(row.key, {
      dimension: response.dimension,
      ...(context.field === undefined ? {} : { field: context.field }),
      timeZone: context.timeZone,
    }),
    value: typeof row.value === 'number' ? row.value : null,
  }));
  if (response.dimension === 'field' && response.others !== undefined) {
    points.push({ label: '其它', value: response.others.value, others: true });
  }
  return {
    kind: response.dimension === 'time' ? 'line' : 'bar',
    points,
    measureLabel: context.measureLabel,
  };
}

export function buildChartOption(model: StatisticsChartModel): Record<string, unknown> {
  const labels = model.points.map((point) => point.label);
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 12, right: 18, top: 28, bottom: 12, containLabel: true },
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: { hideOverlap: true },
    },
    yAxis: { type: 'value' },
    series: [
      {
        name: model.measureLabel,
        type: model.kind === 'line' ? 'line' : 'bar',
        smooth: false,
        showSymbol: model.points.length <= 120,
        connectNulls: false,
        data: model.points.map((point) => ({
          value: point.value,
          itemStyle: point.others === true ? { color: '#9aa5b5' } : undefined,
        })),
      },
    ],
  };
}

export function getTruncationNotice(response: StatisticsResponse): string | undefined {
  return response.truncated ? `分组数超过上限，仅显示前 ${response.rows.length} 项` : undefined;
}
