import 'dotenv/config';

import { accessSync, constants, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { env } from './config/env.js';

function assertSqliteDirectoryWritable(): void {
  const sqliteDirectory = join(env.DATA_DIR, 'sqlite3');
  try {
    mkdirSync(sqliteDirectory, { recursive: true, mode: 0o700 });
    accessSync(sqliteDirectory, constants.W_OK | constants.X_OK);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `SQLite data directory is not writable: ${sqliteDirectory}; reason: ${reason}\n`,
    );
    process.exit(1);
  }
}

assertSqliteDirectoryWritable();

const { buildApp } = await import('./app.js');
const { runReconcile } = await import('./bootstrap/reconcile.js');
const { bootstrapSchema } = await import('./bootstrap/schema.js');
const { bootstrapInitialSuperAdmin } = await import('./domain/users/bootstrap.js');
const { closeClickHouseClients } = await import('./infra/clickhouse.js');
const { closeSqliteDatabase } = await import('./infra/sqlite.js');

const app = await buildApp();

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await closeClickHouseClients();
  closeSqliteDatabase();
}

async function start(): Promise<void> {
  try {
    await bootstrapSchema();
    try {
      await runReconcile({ logger: app.log });
    } catch (error) {
      app.log.error({ err: error, operation: 'reconcile' }, 'startup reconcile failed');
    }
    const bootstrapResult = await bootstrapInitialSuperAdmin();
    if (bootstrapResult === 'created') {
      app.log.warn(
        {
          operator: 'system',
          operation: 'bootstrap_super_admin',
          username: env.BOOTSTRAP_ADMIN_USERNAME,
        },
        'initial super_admin created; remove BOOTSTRAP_ADMIN_PASSWORD from the deployment environment',
      );
    } else if (bootstrapResult === 'credentials_missing') {
      app.log.warn(
        { operation: 'bootstrap_super_admin_skipped' },
        'no super_admin exists and bootstrap credentials are incomplete',
      );
    }
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (error) {
    app.log.fatal({ err: error }, 'server startup failed');
    await closeClickHouseClients();
    closeSqliteDatabase();
    process.exitCode = 1;
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      app.log.error({ err: error }, 'graceful shutdown failed');
      process.exitCode = 1;
    });
  });
}

await start();
