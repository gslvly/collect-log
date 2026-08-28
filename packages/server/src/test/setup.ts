import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 根目录由 global-setup.ts 创建并在 teardown 中整体删除，这里只按 worker 分目录。
const testRoot = process.env.COLLECT_LOG_TEST_ROOT ?? tmpdir();
const testDataDir = join(testRoot, `worker-${process.pid}`);

const requiredTestEnv = {
  PORT: '3000',
  LOG_LEVEL: 'silent',
  DATA_DIR: testDataDir,
  CLICKHOUSE_URL: 'http://localhost:8123',
  CLICKHOUSE_INGEST_USER: 'ch_ingest',
  CLICKHOUSE_INGEST_PASSWORD: 'ingest_pw',
  CLICKHOUSE_META_USER: 'ch_meta',
  CLICKHOUSE_META_PASSWORD: 'meta_pw',
  CLICKHOUSE_READONLY_USER: 'ch_readonly',
  CLICKHOUSE_READONLY_PASSWORD: 'readonly_pw',
  JWT_SECRET: 'test-only-jwt-secret-not-for-production',
  INGEST_ALLOWED_ORIGINS: 'https://ingest.example.test',
  CONSOLE_ALLOWED_ORIGINS: 'https://console.example.test',
} as const;

for (const [name, value] of Object.entries(requiredTestEnv)) {
  process.env[name] ??= value;
}
