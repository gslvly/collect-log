const requiredTestEnv = {
  PORT: '3000',
  LOG_LEVEL: 'silent',
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
