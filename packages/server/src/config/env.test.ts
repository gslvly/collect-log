import { describe, expect, it } from 'vitest';

import { parseEnv } from './env.js';

const validEnv = {
  PORT: '3000',
  LOG_LEVEL: 'info',
  CLICKHOUSE_URL: 'http://localhost:8123',
  CLICKHOUSE_INGEST_USER: 'ch_ingest',
  CLICKHOUSE_INGEST_PASSWORD: 'ingest_pw',
  CLICKHOUSE_META_USER: 'ch_meta',
  CLICKHOUSE_META_PASSWORD: 'meta_pw',
  CLICKHOUSE_READONLY_USER: 'ch_readonly',
  CLICKHOUSE_READONLY_PASSWORD: 'readonly_pw',
  JWT_SECRET: 'test-secret',
  INGEST_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
  CONSOLE_ALLOWED_ORIGINS: 'https://console.example',
};

describe('environment configuration', () => {
  it('parses ports and comma-separated CORS origins', () => {
    expect(parseEnv(validEnv)).toMatchObject({
      PORT: 3000,
      INGEST_ALLOWED_ORIGINS: ['https://a.example', 'https://b.example'],
      CONSOLE_ALLOWED_ORIGINS: ['https://console.example'],
    });
  });

  it('reports every missing required variable clearly', () => {
    expect(() => parseEnv({})).toThrowError(/Invalid environment configuration:[\s\S]*PORT/);
    expect(() => parseEnv({})).toThrowError(/CLICKHOUSE_META_USER/);
    expect(() => parseEnv({})).toThrowError(/CONSOLE_ALLOWED_ORIGINS/);
  });
});
