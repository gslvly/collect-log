import type { ClickHouseClient } from '@clickhouse/client';

import { assertValidFieldKey, physicalTypeFor } from '../domain/tables/schema.js';
import type { FieldRecord, TableRecord } from '../domain/tables/types.js';
import { assertIdentifier, parameterizedQuery } from '../infra/clickhouse.js';

interface SystemTableRow {
  name: string;
}

interface SystemColumnRow {
  name: string;
  type: string;
}

const INTERNAL_COLUMNS = new Set(['_record_id', '_schema_version', '_occurred_at', '_received_at']);

export async function physicalTableExists(
  client: ClickHouseClient,
  physicalName: string,
): Promise<boolean> {
  const safePhysicalName = assertIdentifier(physicalName);
  const rows = await parameterizedQuery<SystemTableRow>({
    client,
    query: `SELECT name
FROM system.tables
WHERE database = {database:String}
  AND name = {name:String}`,
    params: { database: 'data', name: safePhysicalName },
  });
  return rows.length > 0;
}

export async function listPhysicalColumns(
  client: ClickHouseClient,
  physicalName: string,
): Promise<Map<string, string>> {
  const safePhysicalName = assertIdentifier(physicalName);
  const rows = await parameterizedQuery<SystemColumnRow>({
    client,
    query: `SELECT name, type
FROM system.columns
WHERE database = {database:String}
  AND table = {table:String}`,
    params: { database: 'data', table: safePhysicalName },
  });
  return new Map(
    rows.filter((row) => !INTERNAL_COLUMNS.has(row.name)).map((row) => [row.name, row.type]),
  );
}

export async function addPhysicalColumn(
  client: ClickHouseClient,
  table: TableRecord,
  field: FieldRecord,
): Promise<void> {
  const safePhysicalName = assertIdentifier(table.physicalName);
  const safeFieldKey = assertValidFieldKey(field.key);
  const physicalType = physicalTypeFor(field.type);
  await client.command({
    query: `ALTER TABLE data.${safePhysicalName}
ADD COLUMN IF NOT EXISTS \`${safeFieldKey}\` ${physicalType}`,
  });
}

export async function dropPhysicalColumn(
  client: ClickHouseClient,
  table: TableRecord,
  field: FieldRecord,
): Promise<void> {
  const safePhysicalName = assertIdentifier(table.physicalName);
  const safeFieldKey = assertValidFieldKey(field.key);
  await client.command({
    query: `ALTER TABLE data.${safePhysicalName}
DROP COLUMN IF EXISTS \`${safeFieldKey}\``,
  });
}

const LOSSLESS_TEXT_PHYSICAL_TYPES = new Set([
  physicalTypeFor('string'),
  physicalTypeFor('enum'),
]);

export function isLosslessTextEncodingDrift(
  actualType: string,
  expectedType: string,
): boolean {
  return (
    actualType !== expectedType &&
    LOSSLESS_TEXT_PHYSICAL_TYPES.has(actualType) &&
    LOSSLESS_TEXT_PHYSICAL_TYPES.has(expectedType)
  );
}
