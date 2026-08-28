import { assertIdentifier, ingestClient } from '../../infra/clickhouse.js';
import { assertValidFieldKey } from '../tables/schema.js';
import type { TableDefinition } from '../tables/types.js';
import type { IngestPayload, ValidatedFieldValues } from './validate.js';

export type IngestRow = Record<string, string | number | boolean | null>;

export function formatOccurredAt(occurredAt: number): string {
  return new Date(occurredAt).toISOString().replace('T', ' ').replace('Z', '');
}

export function buildIngestRow(
  definition: Pick<TableDefinition, 'schemaVersion' | 'fields'>,
  payload: Pick<IngestPayload, 'recordId' | 'occurredAt'>,
  values: ValidatedFieldValues,
): IngestRow {
  const row: IngestRow = {
    _record_id: payload.recordId,
    _schema_version: definition.schemaVersion,
    _occurred_at: formatOccurredAt(payload.occurredAt),
  };
  for (const field of definition.fields) {
    const fieldKey = assertValidFieldKey(field.key);
    row[fieldKey] = values[fieldKey] ?? null;
  }
  return row;
}

export async function insertIngestRow(physicalName: string, row: IngestRow): Promise<void> {
  await ingestClient.insert({
    table: `data.${assertIdentifier(physicalName)}`,
    values: [row],
    format: 'JSONEachRow',
    clickhouse_settings: {
      async_insert: 1,
      wait_for_async_insert: 1,
      async_insert_busy_timeout_max_ms: 1000,
      async_insert_max_data_size: '1048576',
    },
  });
}
