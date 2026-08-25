import { createClient, type ClickHouseClient } from '@clickhouse/client';

import { env } from '../config/env.js';
import { configuredLimits } from '../config/limits.js';

export const clientDefaultSettings = {
  ingest: {},
  meta: {
    optimize_move_to_prewhere_if_final: 0,
  },
  readonly: {
    optimize_move_to_prewhere_if_final: 0,
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

export const metaClient = createClient({
  url: env.CLICKHOUSE_URL,
  username: env.CLICKHOUSE_META_USER,
  password: env.CLICKHOUSE_META_PASSWORD,
  clickhouse_settings: clientDefaultSettings.meta,
});

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
