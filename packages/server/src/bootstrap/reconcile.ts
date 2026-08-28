import type { ClickHouseClient } from '@clickhouse/client';

import { tableRepository, type TableRepository } from '../domain/tables/repository.js';
import {
  assertValidFieldKey,
  FIELD_KEY_PATTERN,
  physicalTypeFor,
} from '../domain/tables/schema.js';
import type { FieldRecord, TableRecord, TableStatus } from '../domain/tables/types.js';
import { assertIdentifier, metaClient, parameterizedQuery } from '../infra/clickhouse.js';
import { serial } from '../infra/serial.js';
import { setReconcileState, type ReconcileResult } from '../reconcile-state.js';

interface SystemTableRow {
  name: string;
}

interface SystemColumnRow {
  name: string;
  type: string;
}

export interface ReconcileLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface RunReconcileOptions {
  repository?: TableRepository;
  logger?: ReconcileLogger;
  client?: ClickHouseClient;
}

interface ReconcileContext {
  repository: TableRepository;
  logger: ReconcileLogger;
  client: ClickHouseClient;
  fixed: number;
  failed: number;
}

const INTERNAL_COLUMNS = new Set(['_record_id', '_schema_version', '_occurred_at', '_received_at']);

const silentLogger: ReconcileLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function physicalTableExists(
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

async function listPhysicalColumns(
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

async function addPhysicalColumn(
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

async function dropPhysicalColumn(
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

async function reconcileTableStatuses(context: ReconcileContext): Promise<void> {
  const tables = await context.repository.list();
  const candidates = tables.filter(
    (table) => table.status === 'creating' || table.status === 'failed',
  );

  for (const table of candidates) {
    try {
      const exists = await physicalTableExists(context.client, table.physicalName);
      if (!exists && table.status === 'failed') {
        continue;
      }

      if (exists && table.status === 'failed') {
        await context.repository.setStatus(table.projectId, 'creating');
        await context.repository.setStatus(table.projectId, 'active');
      } else {
        await context.repository.setStatus(table.projectId, exists ? 'active' : 'failed');
      }

      context.fixed += 1;
      context.logger.info(
        {
          operation: 'reconcile_table_status',
          projectId: table.projectId,
          physicalName: table.physicalName,
          fromStatus: table.status,
          toStatus: exists ? 'active' : 'failed',
        },
        'reconciled collection table status',
      );
    } catch (error) {
      context.failed += 1;
      context.logger.error(
        {
          operation: 'reconcile_table_status',
          projectId: table.projectId,
          physicalName: table.physicalName,
          err: error,
        },
        'failed to reconcile collection table status',
      );
    }
  }

  // DESIGN 7.4 第 2 步：archived 缺物理表是 7.5 删除在 DROP 后中断的无害残留。
  // 这里只提示操作者重试删除，绝不发 DDL、改状态或计入修复/失败数量。
  for (const table of tables.filter((candidate) => candidate.status === 'archived')) {
    try {
      if (await physicalTableExists(context.client, table.physicalName)) {
        continue;
      }
      context.logger.warn(
        {
          operation: 'reconcile_incomplete_table_deletion',
          projectId: table.projectId,
          physicalName: table.physicalName,
          displayName: table.displayName,
        },
        'archived table is missing after a partial deletion; retry deletion to finish cleanup',
      );
    } catch (error) {
      context.failed += 1;
      context.logger.error(
        {
          operation: 'reconcile_archived_table_check',
          projectId: table.projectId,
          physicalName: table.physicalName,
          err: error,
        },
        'failed to inspect archived collection table',
      );
    }
  }
}

async function repairMissingColumn(
  context: ReconcileContext,
  table: TableRecord,
  field: FieldRecord,
): Promise<void> {
  try {
    await addPhysicalColumn(context.client, table, field);
    context.repository.clearCache();
    context.fixed += 1;
    context.logger.info(
      {
        operation: 'reconcile_add_column',
        projectId: table.projectId,
        physicalName: table.physicalName,
        fieldKey: field.key,
      },
      'restored missing physical column',
    );
  } catch (error) {
    context.failed += 1;
    context.logger.error(
      {
        operation: 'reconcile_add_column',
        projectId: table.projectId,
        physicalName: table.physicalName,
        fieldKey: field.key,
        err: error,
      },
      'failed to restore missing physical column',
    );
  }
}

// DESIGN 7.3 的 rename 中间态：`RENAME COLUMN` 已经生效、承载新旧两行的 SQLite 事务却没提交。
// 元数据里旧 Key 仍是 `active` 而它的列不见了，改名后的列成了没有元数据的孤儿。
// 这时补 `ADD COLUMN` 只会建出一个空列，把历史数据永久留在孤儿列里，
// 与 7.3「重命名不丢数据」相悖，所以改成反向 `RENAME` 把数据接回旧 Key，
// 让操作者可以重新发起一次重命名。
async function repairInterruptedRename(
  context: ReconcileContext,
  table: TableRecord,
  orphanColumn: string,
  field: FieldRecord,
): Promise<void> {
  const safePhysicalName = assertIdentifier(table.physicalName);
  const safeOrphanColumn = assertValidFieldKey(orphanColumn);
  const safeFieldKey = assertValidFieldKey(field.key);
  try {
    await context.client.command({
      query: `ALTER TABLE data.${safePhysicalName}
RENAME COLUMN \`${safeOrphanColumn}\` TO \`${safeFieldKey}\``,
    });
    context.repository.clearCache();
    context.fixed += 1;
    context.logger.info(
      {
        operation: 'reconcile_revert_rename',
        projectId: table.projectId,
        physicalName: table.physicalName,
        fieldKey: field.key,
        orphanColumn,
      },
      'reverted an interrupted column rename and kept its data',
    );
  } catch (error) {
    context.failed += 1;
    context.logger.error(
      {
        operation: 'reconcile_revert_rename',
        projectId: table.projectId,
        physicalName: table.physicalName,
        fieldKey: field.key,
        orphanColumn,
        err: error,
      },
      'failed to revert an interrupted column rename',
    );
  }
}

async function repairRetiredColumn(
  context: ReconcileContext,
  table: TableRecord,
  field: FieldRecord,
): Promise<void> {
  try {
    await dropPhysicalColumn(context.client, table, field);
    context.repository.clearCache();
    context.fixed += 1;
    context.logger.info(
      {
        operation: 'reconcile_drop_column',
        projectId: table.projectId,
        physicalName: table.physicalName,
        fieldKey: field.key,
        fieldStatus: field.status,
      },
      'removed retired physical column',
    );
  } catch (error) {
    context.failed += 1;
    context.logger.error(
      {
        operation: 'reconcile_drop_column',
        projectId: table.projectId,
        physicalName: table.physicalName,
        fieldKey: field.key,
        fieldStatus: field.status,
        err: error,
      },
      'failed to remove retired physical column',
    );
  }
}

async function reconcileTableSchema(context: ReconcileContext, table: TableRecord): Promise<void> {
  let fields: FieldRecord[];
  let physicalColumns: Map<string, string>;
  try {
    [fields, physicalColumns] = await Promise.all([
      context.repository.listFields(table.projectId),
      listPhysicalColumns(context.client, table.physicalName),
    ]);
  } catch (error) {
    context.failed += 1;
    context.logger.error(
      {
        operation: 'reconcile_schema_drift',
        projectId: table.projectId,
        physicalName: table.physicalName,
        err: error,
      },
      'failed to inspect collection table schema drift',
    );
    return;
  }

  const fieldsByKey = new Map(fields.map((field) => [field.key, field]));
  const missingActive = fields.filter(
    (field) => field.status === 'active' && !physicalColumns.has(field.key),
  );
  const orphanColumns = [...physicalColumns.keys()].filter((name) => !fieldsByKey.has(name));

  // 只在信号足够强时才认定是被打断的重命名：恰好一个缺列的 active 字段、
  // 恰好一个孤儿列、物理类型一致。任何一条不满足都退回原来的逐条修复。
  const missingField = missingActive[0];
  const orphanColumn = orphanColumns[0];
  if (
    missingActive.length === 1 &&
    orphanColumns.length === 1 &&
    missingField !== undefined &&
    orphanColumn !== undefined &&
    FIELD_KEY_PATTERN.test(orphanColumn) &&
    physicalColumns.get(orphanColumn) === physicalTypeFor(missingField.type)
  ) {
    await repairInterruptedRename(context, table, orphanColumn, missingField);
    return;
  }

  for (const field of fields) {
    if (field.status === 'active' && !physicalColumns.has(field.key)) {
      await repairMissingColumn(context, table, field);
    }
  }

  for (const fieldKey of physicalColumns.keys()) {
    const field = fieldsByKey.get(fieldKey);
    if (field === undefined) {
      context.logger.warn(
        {
          operation: 'reconcile_unmanaged_column',
          projectId: table.projectId,
          physicalName: table.physicalName,
          fieldKey,
        },
        'physical column has no field metadata; leaving it unchanged',
      );
      continue;
    }

    if (field.status === 'dropped' || field.status === 'renamed') {
      await repairRetiredColumn(context, table, field);
    }
  }
}

// DESIGN 7.4 第 3 步：`disabled` 表也要查——字段变更接口对它是放行的
// （见 requireFieldChangeableTableSync），同样会留下跨存储的中间态。
// `creating` / `failed` 由第 1 步处理，`archived` 不再接受字段变更，都不需要 drift 校验。
const DRIFT_CHECKED_STATUSES: ReadonlySet<TableStatus> = new Set<TableStatus>([
  'active',
  'disabled',
]);

async function reconcileSchemas(context: ReconcileContext): Promise<void> {
  const tables = (await context.repository.list()).filter((table) =>
    DRIFT_CHECKED_STATUSES.has(table.status),
  );
  for (const table of tables) {
    await reconcileTableSchema(context, table);
  }
}

export async function runReconcile(options: RunReconcileOptions = {}): Promise<ReconcileResult> {
  const context: ReconcileContext = {
    repository: options.repository ?? tableRepository,
    logger: options.logger ?? silentLogger,
    client: options.client ?? metaClient,
    fixed: 0,
    failed: 0,
  };
  let roundError: unknown;
  let roundFailed = false;

  try {
    await serial(async () => {
      await reconcileTableStatuses(context);
      await reconcileSchemas(context);
    });
  } catch (error) {
    roundError = error;
    roundFailed = true;
    context.failed += 1;
    context.logger.error(
      { operation: 'reconcile', err: error },
      'startup reconcile failed before completing the round',
    );
  }

  const result: ReconcileResult = {
    at: new Date().toISOString(),
    fixed: context.fixed,
    failed: context.failed,
  };
  setReconcileState(result);
  const completionBindings = { operation: 'reconcile_complete', ...result };
  if (result.failed > 0) {
    context.logger.warn(completionBindings, 'startup reconcile completed with failures');
  } else {
    context.logger.info(completionBindings, 'startup reconcile completed');
  }

  if (roundFailed) {
    throw roundError;
  }
  return result;
}
