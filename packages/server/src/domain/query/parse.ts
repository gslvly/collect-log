import { z } from 'zod';

import { AppError } from '../../errors.js';
import { FIELD_MEASURES, measureRequiresField } from '../field-types.js';
import {
  OCCURRED_AT_AXIS,
  type Condition,
  type DetailQueryInput,
  type ExportInput,
  type QueryLimits,
  type StatisticsDimension,
  type StatisticsInput,
  type StatisticsMeasure,
  type TimeRange,
} from './types.js';

const PROJECT_ID_PATTERN = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY_MS = 86_400_000;

const projectIdParamsSchema = z.object({ projectId: z.string() });
const rangeSchema = z
  .object({
    start: z.number().int(),
    end: z.number().int(),
  })
  .strict();

const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z
      .object({
        op: z.enum(['and', 'or']),
        conditions: z.array(conditionSchema),
      })
      .strict(),
    z
      .object({
        field: z.string(),
        op: z.enum([
          'eq',
          'neq',
          'in',
          'not_in',
          'contains',
          'not_contains',
          'is_empty',
          'is_not_empty',
          'gt',
          'gte',
          'lt',
          'lte',
          'is_null',
          'is_not_null',
        ]),
        value: z
          .union([z.string(), z.array(z.string()), z.number(), z.array(z.number()), z.boolean()])
          .optional(),
      })
      .strict(),
  ]),
);

const detailQuerySchema = z
  .object({
    range: z.unknown(),
    filter: conditionSchema.optional(),
    includeFields: z.array(z.string()).optional(),
    limit: z.number().int().optional(),
    order: z.enum(['asc', 'desc']).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

// DESIGN 9.4.1：两种 kind 的可选键不同，但故意收在同一个 schema 里 ——
// 让「时间维度带了 limit」这类错误由下面的 parseDimension 给出指名道姓的说明，
// 而不是被 Zod 的判别联合吞成笼统的 "does not match the expected shape"。
const dimensionSchema = z
  .object({
    kind: z.enum(['time', 'field']),
    axis: z.string().optional(),
    granularity: z.enum(['minute', 'hour', 'day']).optional(),
    field: z.string().optional(),
    limit: z.number().int().optional(),
  })
  .strict();

const measureSchema = z
  .object({
    fn: z.enum(FIELD_MEASURES),
    field: z.string().optional(),
  })
  .strict();

const statisticsSchema = z
  .object({
    range: z.unknown(),
    filter: conditionSchema.optional(),
    // tz 故意放成 unknown：缺失 / 空串 / 偏移形式都要由 assertValidTimeZone 给出
    // 指名道姓的报错，而不是被 Zod 吞成笼统的 "does not match the expected shape"。
    tz: z.unknown().optional(),
    dimension: dimensionSchema.nullable().optional(),
    measure: measureSchema,
  })
  .strict();

const exportSchema = z
  .object({
    range: z.unknown(),
    filter: conditionSchema.optional(),
    includeFields: z.array(z.string()).optional(),
    order: z.enum(['asc', 'desc']).optional(),
  })
  .strict();

function invalidQuery(message: string): never {
  throw new AppError('INVALID_QUERY', message);
}

export function parseProjectId(input: unknown): string {
  const parsed = projectIdParamsSchema.safeParse(input);
  const rawProjectId =
    typeof input === 'object' && input !== null && 'projectId' in input
      ? (input as { projectId: unknown }).projectId
      : input;
  const projectId = parsed.success ? parsed.data.projectId : String(rawProjectId);
  if (!parsed.success || !PROJECT_ID_PATTERN.test(projectId)) {
    throw new AppError('INVALID_PROJECT_ID', `Project ID "${projectId}" is invalid`);
  }
  return projectId;
}

export function parseTimeRange(input: unknown, maxRangeDays: number): TimeRange {
  const parsed = rangeSchema.safeParse(input);
  if (!parsed.success) {
    return invalidQuery('Time range must contain integer start and end millisecond timestamps');
  }
  const { start, end } = parsed.data;
  if (!Number.isFinite(new Date(start).getTime()) || !Number.isFinite(new Date(end).getTime())) {
    return invalidQuery('Time range contains a timestamp outside the supported date range');
  }
  if (start >= end) {
    return invalidQuery('Time range start must be earlier than end');
  }
  if (end - start > maxRangeDays * DAY_MS) {
    return invalidQuery(`Time range must not exceed ${maxRangeDays} days`);
  }
  return { start, end };
}

function parseShape<T>(schema: z.ZodType<T>, input: unknown, subject: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return invalidQuery(`${subject} does not match the expected shape`);
  }
  return parsed.data;
}

function normalizeIncludeFields(includeFields: readonly string[] | undefined): string[] {
  return [...new Set(includeFields ?? [])].sort();
}

export function parseDetailQuery(input: unknown, limits: QueryLimits): DetailQueryInput {
  const parsed = parseShape(detailQuerySchema, input, 'Detail query');
  const range = parseTimeRange(parsed.range, limits.maxRangeDays);
  const limit = parsed.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > limits.maxRows) {
    return invalidQuery(`Detail query limit must be between 1 and ${limits.maxRows}`);
  }
  return {
    range,
    ...(parsed.filter === undefined ? {} : { filter: parsed.filter }),
    includeFields: normalizeIncludeFields(parsed.includeFields),
    limit,
    order: parsed.order ?? 'desc',
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
  };
}

const TZ_REQUIRED_MESSAGE =
  'Statistics require an IANA time zone name from the client, for example "Asia/Shanghai"';

/**
 * DESIGN 9.2：按时间粒度聚合的接口必须由客户端传时区，服务端不提供任何默认值。
 *
 * 只接受 IANA 时区名，**拒绝 `+08:00` 这类 UTC 偏移串**：`Intl` 从 ES2021 起接受偏移形式，
 * 但 ClickHouse 的 `toStartOfDay(x, tz)` 只认 tzdata 里的时区名，传偏移串会在 CH 侧
 * 抛 Code 36 `Cannot load time zone +08:00`（已实测），最终落到 500 而不是 400。
 * 必须在入口就挡掉。IANA 别名（`Asia/Calcutta`、`US/Pacific`）CH 认，放行。
 *
 * 偏移形式的判定依据是 `resolvedOptions().timeZone`：它对偏移串返回规范化的
 * `+08:00` / `-05:00`，对时区名返回时区名。
 */
export function assertValidTimeZone(tz: unknown): string {
  if (typeof tz !== 'string' || tz === '') {
    return invalidQuery(TZ_REQUIRED_MESSAGE);
  }

  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return invalidQuery(`Time zone "${tz}" is invalid`);
  }

  if (resolved.startsWith('+') || resolved.startsWith('-')) {
    return invalidQuery(
      `Time zone "${tz}" is a UTC offset, which ClickHouse cannot resolve. ${TZ_REQUIRED_MESSAGE}`,
    );
  }
  return tz;
}

export function assertTrendRange(range: TimeRange, granularity: 'minute' | 'hour' | 'day'): void {
  const span = range.end - range.start;
  if (granularity === 'minute' && span > 2 * DAY_MS) {
    invalidQuery('Time range for minute granularity must not exceed 2 days');
  }
  if (granularity === 'hour' && span > 31 * DAY_MS) {
    invalidQuery('Time range for hour granularity must not exceed 31 days');
  }
}

type RawDimension = z.infer<typeof dimensionSchema>;
type RawMeasure = z.infer<typeof measureSchema>;

function parseDimension(
  raw: RawDimension | null | undefined,
  range: TimeRange,
  limits: QueryLimits,
): StatisticsDimension | undefined {
  // DESIGN 9.4.1：省略 / null 都表示「不分组，返回单个值」。
  if (raw === undefined || raw === null) {
    return undefined;
  }

  if (raw.kind === 'time') {
    if (raw.field !== undefined) {
      return invalidQuery('Time dimension takes "axis", not "field"');
    }
    // DESIGN 9.4.1：桶数已被「跨度 × 粒度」限死，再给一个 limit 只会截出一段没头没尾的时间轴。
    if (raw.limit !== undefined) {
      return invalidQuery(
        'Time dimension does not accept "limit"; the bucket count is already bounded by the time range and granularity',
      );
    }
    if (raw.granularity === undefined) {
      return invalidQuery('Time dimension requires a granularity of "minute", "hour", or "day"');
    }
    assertTrendRange(range, raw.granularity);
    return { kind: 'time', axis: raw.axis ?? OCCURRED_AT_AXIS, granularity: raw.granularity };
  }

  if (raw.axis !== undefined || raw.granularity !== undefined) {
    return invalidQuery('Field dimension does not accept "axis" or "granularity"');
  }
  if (raw.field === undefined) {
    return invalidQuery('Field dimension requires a field');
  }
  const limit = raw.limit ?? limits.defaultGroupLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > limits.maxGroupLimit) {
    return invalidQuery(`Group limit must be between 1 and ${limits.maxGroupLimit}`);
  }
  return { kind: 'field', field: raw.field, limit };
}

function parseMeasure(raw: RawMeasure): StatisticsMeasure {
  if (!measureRequiresField(raw.fn)) {
    // DESIGN 9.4.2：想要「该字段非空的行数」请用 unique 或加一个 is_not_null 条件，
    // 不要让 count 有两种含义。
    if (raw.field !== undefined) {
      return invalidQuery(
        `Measure "${raw.fn}" does not accept a field; use "unique" or an is_not_null filter to count rows that carry a field`,
      );
    }
    return { fn: raw.fn };
  }
  if (raw.field === undefined) {
    return invalidQuery(`Measure "${raw.fn}" requires a field`);
  }
  return { fn: raw.fn, field: raw.field };
}

export function parseStatisticsQuery(input: unknown, limits: QueryLimits): StatisticsInput {
  const parsed = parseShape(statisticsSchema, input, 'Statistics query');
  const range = parseTimeRange(parsed.range, limits.maxRangeDays);
  const tz = assertValidTimeZone(parsed.tz);
  const dimension = parseDimension(parsed.dimension, range, limits);

  return {
    range,
    ...(parsed.filter === undefined ? {} : { filter: parsed.filter }),
    tz,
    ...(dimension === undefined ? {} : { dimension }),
    measure: parseMeasure(parsed.measure),
  };
}

export function parseExportQuery(input: unknown, limits: QueryLimits): ExportInput {
  const parsed = parseShape(exportSchema, input, 'Export query');
  return {
    range: parseTimeRange(parsed.range, limits.maxRangeDays),
    ...(parsed.filter === undefined ? {} : { filter: parsed.filter }),
    includeFields: normalizeIncludeFields(parsed.includeFields),
    order: parsed.order ?? 'desc',
  };
}
