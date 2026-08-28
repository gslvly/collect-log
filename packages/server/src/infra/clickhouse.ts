import { createClient, type ClickHouseClient, type ClickHouseSettings } from '@clickhouse/client';

import { env } from '../config/env.js';
import { configuredLimits } from '../config/limits.js';

export const clientDefaultSettings = {
  ingest: {},
  meta: {},
  readonly: {
    max_execution_time: configuredLimits.query.maxExecutionTimeSec,
    max_memory_usage: String(configuredLimits.query.maxMemoryUsageBytes),
    max_result_rows: String(configuredLimits.query.maxRows),
  },
} as const;

export const ingestClient = createClient({
  url: env.CLICKHOUSE_URL,
  username: env.CLICKHOUSE_INGEST_USER,
  password: env.CLICKHOUSE_INGEST_PASSWORD,
  clickhouse_settings: clientDefaultSettings.ingest,
});

// ch_meta 只负责 data.* DDL 与 system.* 只读比对，不再承载管理元数据。
export const metaClient = createClient({
  url: env.CLICKHOUSE_URL,
  username: env.CLICKHOUSE_META_USER,
  password: env.CLICKHOUSE_META_PASSWORD,
  clickhouse_settings: clientDefaultSettings.meta,
});

// ch_readonly 只查询 data.* 业务数据。
export const readonlyClient = createClient({
  url: env.CLICKHOUSE_URL,
  username: env.CLICKHOUSE_READONLY_USER,
  password: env.CLICKHOUSE_READONLY_PASSWORD,
  clickhouse_settings: clientDefaultSettings.readonly,
});

export interface ParameterizedQueryOptions {
  client: ClickHouseClient;
  query: string;
  params: Record<string, unknown>;
}

export async function parameterizedQuery<Row>(options: ParameterizedQueryOptions): Promise<Row[]> {
  const result = await options.client.query({
    query: options.query,
    query_params: options.params,
    format: 'JSONEachRow',
  });
  return result.json<Row>();
}

export interface CsvStreamRow {
  text: string;
}

export interface CsvStreamQueryOptions extends ParameterizedQueryOptions {
  clickhouseSettings: ClickHouseSettings;
  abortSignal?: AbortSignal;
}

export async function streamCsvQuery(
  options: CsvStreamQueryOptions,
): Promise<AsyncIterable<readonly CsvStreamRow[]>> {
  const result = await options.client.query({
    query: options.query,
    query_params: options.params,
    format: 'CSVWithNames',
    clickhouse_settings: options.clickhouseSettings,
    ...(options.abortSignal === undefined ? {} : { abort_signal: options.abortSignal }),
  });
  return result.stream();
}

export type ClickHouseFailureKind = 'unavailable' | 'limit_exceeded' | 'server_error';

const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENOTFOUND',
]);
const LIMIT_EXCEEDED_CODES = new Set(['159', '160', '241', '396']);

function failureProperties(error: unknown): Array<Record<string, unknown>> {
  const properties: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    properties.push(record);
    current = record.cause;
  }
  return properties;
}

export function classifyClickHouseError(error: unknown): ClickHouseFailureKind {
  const properties = failureProperties(error);

  for (const property of properties) {
    const code = String(property.code ?? '');
    if (LIMIT_EXCEEDED_CODES.has(code)) {
      return 'limit_exceeded';
    }
  }

  for (const property of properties) {
    const code = String(property.code ?? '').toUpperCase();
    const name = String(property.name ?? '');
    const message = String(property.message ?? '');
    if (
      UNAVAILABLE_CODES.has(code) ||
      name === 'AbortError' ||
      name === 'TimeoutError' ||
      /socket hang up/i.test(message)
    ) {
      return 'unavailable';
    }
  }

  return 'server_error';
}

export function assertIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]{0,63}$/.test(identifier)) {
    throw new Error(`Invalid ClickHouse identifier: "${identifier}"`);
  }
  return identifier;
}

export const CLICKHOUSE_PING_TIMEOUT_MS = 3_000;

export type ClickHousePingQuery = (abortSignal: AbortSignal) => Promise<void>;

async function runClickHousePing(abortSignal: AbortSignal): Promise<void> {
  const result = await readonlyClient.query({
    query: 'SELECT 1',
    format: 'JSONEachRow',
    abort_signal: abortSignal,
  });
  await result.json();
}

export async function pingClickHouse(
  runQuery: ClickHousePingQuery = runClickHousePing,
  timeoutMs = CLICKHOUSE_PING_TIMEOUT_MS,
): Promise<void> {
  await runQuery(AbortSignal.timeout(timeoutMs));
}

export async function closeClickHouseClients(): Promise<void> {
  await Promise.all([ingestClient.close(), metaClient.close(), readonlyClient.close()]);
}
