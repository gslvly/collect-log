import { z } from 'zod';

import { AppError } from '../../errors.js';
import type {
  Condition,
  DetailQueryInput,
  ExportInput,
  QueryLimits,
  StatisticsInput,
  TimeRange,
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
          'is_null',
          'is_not_null',
        ]),
        value: z.union([z.string(), z.array(z.string()), z.boolean()]).optional(),
      })
      .strict(),
  ]),
);

const detailQuerySchema = z
  .object({
    range: z.unknown(),
    filter: conditionSchema.optional(),
    limit: z.number().int().optional(),
    order: z.enum(['asc', 'desc']).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

const statisticsSchema = z
  .object({
    range: z.unknown(),
    filter: conditionSchema.optional(),
    // tz 故意放成 unknown：缺失 / 空串 / 偏移形式都要由 assertValidTimeZone 给出
    // 指名道姓的报错，而不是被 Zod 吞成笼统的 "does not match the expected shape"。
    tz: z.unknown().optional(),
    metric: z.enum(['total', 'trend', 'unique', 'group', 'boolean_ratio']),
    granularity: z.enum(['minute', 'hour', 'day']).optional(),
    field: z.string().optional(),
    limit: z.number().int().optional(),
  })
  .strict();

const exportSchema = z
  .object({
    range: z.unknown(),
    filter: conditionSchema.optional(),
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

export function parseStatisticsQuery(input: unknown, limits: QueryLimits): StatisticsInput {
  const parsed = parseShape(statisticsSchema, input, 'Statistics query');
  const range = parseTimeRange(parsed.range, limits.maxRangeDays);
  const tz = assertValidTimeZone(parsed.tz);

  if (parsed.metric === 'trend') {
    if (parsed.granularity === undefined) {
      return invalidQuery('Granularity is required for trend statistics');
    }
    assertTrendRange(range, parsed.granularity);
  } else if (parsed.granularity !== undefined) {
    return invalidQuery('Granularity is only supported for trend statistics');
  }

  if (['unique', 'group', 'boolean_ratio'].includes(parsed.metric) && parsed.field === undefined) {
    return invalidQuery(`Field is required for ${parsed.metric} statistics`);
  }
  if (!['unique', 'group', 'boolean_ratio'].includes(parsed.metric) && parsed.field !== undefined) {
    return invalidQuery(`Field is not supported for ${parsed.metric} statistics`);
  }

  let limit = parsed.limit;
  if (parsed.metric === 'group') {
    limit ??= 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      return invalidQuery('Group limit must be between 1 and 500');
    }
  } else if (limit !== undefined) {
    return invalidQuery('Limit is only supported for group statistics');
  }

  return {
    range,
    ...(parsed.filter === undefined ? {} : { filter: parsed.filter }),
    tz,
    metric: parsed.metric,
    ...(parsed.granularity === undefined ? {} : { granularity: parsed.granularity }),
    ...(parsed.field === undefined ? {} : { field: parsed.field }),
    ...(limit === undefined ? {} : { limit }),
  };
}

export function parseExportQuery(input: unknown, limits: QueryLimits): ExportInput {
  const parsed = parseShape(exportSchema, input, 'Export query');
  return {
    range: parseTimeRange(parsed.range, limits.maxRangeDays),
    ...(parsed.filter === undefined ? {} : { filter: parsed.filter }),
    order: parsed.order ?? 'desc',
  };
}
