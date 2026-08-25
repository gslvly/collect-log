import { metaClient } from '../infra/clickhouse.js';
import { serial } from '../infra/serial.js';

const schemaStatements = [
  `CREATE DATABASE IF NOT EXISTS meta;`,
  `CREATE DATABASE IF NOT EXISTS data;`,
  `CREATE TABLE IF NOT EXISTS meta.app_users
(
    user_id       UUID,
    username      String,
    password_hash String,
    role          String,
    status        String,
    version       UInt64,
    created_at    DateTime64(3, 'UTC'),
    updated_at    DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(version)
ORDER BY username;`,
  `CREATE TABLE IF NOT EXISTS meta.collect_tables
(
    table_id           String,
    project_id         String,
    physical_name      String,
    display_name       String,
    description        String,
    status             String,
    schema_version     UInt32,
    ingest_secret      String,
    ingest_secret_prev String,
    created_by         String,
    version            UInt64,
    created_at         DateTime64(3, 'UTC'),
    updated_at         DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(version)
ORDER BY table_id;`,
  `CREATE TABLE IF NOT EXISTS meta.collect_fields
(
    table_id       String,
    field_key      String,
    label          String,
    type           String,
    required       Bool,
    description    String,
    status         String,
    renamed_to     String,
    schema_version UInt32,
    version        UInt64,
    created_at     DateTime64(3, 'UTC'),
    updated_at     DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (table_id, field_key);`,
] as const;

export function bootstrapSchema(): Promise<void> {
  return serial(async () => {
    for (const query of schemaStatements) {
      await metaClient.command({ query });
    }
  });
}
