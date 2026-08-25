import 'dotenv/config';

import { buildApp } from './app.js';
import { bootstrapSchema } from './bootstrap/schema.js';
import { env } from './config/env.js';
import { bootstrapInitialSuperAdmin } from './domain/users/bootstrap.js';
import { closeClickHouseClients } from './infra/clickhouse.js';

const app = await buildApp();

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await closeClickHouseClients();
}

async function start(): Promise<void> {
  try {
    await bootstrapSchema();
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
