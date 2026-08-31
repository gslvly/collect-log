import { assertIdentifier, metaClient, parameterizedQuery } from '../../infra/clickhouse.js';
import { assertValidFieldKey, physicalTypeFor } from './schema.js';
import type { RetypeFieldInput } from './types.js';

export async function addPhysicalColumn(
  physicalName: string,
  fieldKey: string,
  physicalType: string,
): Promise<void> {
  const safePhysicalName = assertIdentifier(physicalName);
  const safeFieldKey = assertValidFieldKey(fieldKey);
  await metaClient.command({
    query: `ALTER TABLE data.${safePhysicalName}
ADD COLUMN IF NOT EXISTS \`${safeFieldKey}\` ${physicalType}`,
  });
}

export async function retypePhysicalColumn(
  physicalName: string,
  fieldKey: string,
  targetType: RetypeFieldInput['type'],
): Promise<void> {
  const safePhysicalName = assertIdentifier(physicalName);
  const safeFieldKey = assertValidFieldKey(fieldKey);
  await metaClient.command({
    query: `ALTER TABLE data.${safePhysicalName}
MODIFY COLUMN \`${safeFieldKey}\` ${physicalTypeFor(targetType)}`,
  });
}

async function physicalColumnNames(physicalName: string): Promise<Set<string>> {
  const rows = await parameterizedQuery<{ name: string }>({
    client: metaClient,
    query: `SELECT name
FROM system.columns
WHERE database = {database:String}
  AND table = {table:String}`,
    params: { database: 'data', table: assertIdentifier(physicalName) },
  });
  return new Set(rows.map((row) => row.name));
}

export async function renamePhysicalColumn(
  physicalName: string,
  fieldKey: string,
  newFieldKey: string,
): Promise<void> {
  const safePhysicalName = assertIdentifier(physicalName);
  const safeFieldKey = assertValidFieldKey(fieldKey);
  const safeNewFieldKey = assertValidFieldKey(newFieldKey);
  // DESIGN 7.3：`RENAME COLUMN` 没有 `IF EXISTS`。上一次 DDL 成功之后若 SQLite 侧中断，
  // 重试会因旧列已不存在而失败，数据反而卡在中间态。先看一眼物理列，
  // 改名已经发生过就直接跳过，让「再点一次 rename」能把元数据补完收尾。
  const columns = await physicalColumnNames(safePhysicalName);
  if (!columns.has(safeFieldKey) && columns.has(safeNewFieldKey)) {
    return;
  }
  await metaClient.command({
    query: `ALTER TABLE data.${safePhysicalName}
RENAME COLUMN \`${safeFieldKey}\` TO \`${safeNewFieldKey}\``,
  });
}

export async function dropPhysicalColumn(
  physicalName: string,
  fieldKey: string,
): Promise<void> {
  const safePhysicalName = assertIdentifier(physicalName);
  const safeFieldKey = assertValidFieldKey(fieldKey);
  await metaClient.command({
    query: `ALTER TABLE data.${safePhysicalName}
DROP COLUMN IF EXISTS \`${safeFieldKey}\``,
  });
}
