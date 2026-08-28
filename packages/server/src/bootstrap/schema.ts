import { metaClient } from '../infra/clickhouse.js';
import { serial } from '../infra/serial.js';
import { sqliteDatabase, type SqliteDatabase } from '../infra/sqlite.js';

const sqliteSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS app_users
(
    user_id       TEXT    NOT NULL PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('super_admin', 'admin', 'user')),
    status        TEXT    NOT NULL CHECK (status IN ('active', 'disabled')),
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL
) STRICT;`,
  `CREATE TABLE IF NOT EXISTS collect_tables
(
    project_id                    TEXT    NOT NULL PRIMARY KEY,
    physical_name                 TEXT    NOT NULL UNIQUE,
    display_name                  TEXT    NOT NULL,
    description                   TEXT    NOT NULL DEFAULT '',
    status                        TEXT    NOT NULL
        CHECK (status IN ('creating', 'active', 'disabled', 'archived', 'failed')),
    schema_version                INTEGER NOT NULL,
    ingest_secret                 TEXT    NOT NULL,
    ingest_secret_prev            TEXT    NOT NULL DEFAULT '',
    ingest_secret_prev_expires_at TEXT,
    created_by                    TEXT    NOT NULL,
    created_at                    TEXT    NOT NULL,
    updated_at                    TEXT    NOT NULL
) STRICT;`,
  `CREATE TABLE IF NOT EXISTS collect_fields
(
    project_id     TEXT    NOT NULL REFERENCES collect_tables(project_id),
    field_key      TEXT    NOT NULL,
    label          TEXT    NOT NULL,
    type           TEXT    NOT NULL CHECK (type IN ('string', 'boolean')),
    required       INTEGER NOT NULL CHECK (required IN (0, 1)),
    description    TEXT    NOT NULL DEFAULT '',
    status         TEXT    NOT NULL
        CHECK (status IN ('active', 'deprecated', 'dropped', 'renamed')),
    renamed_to     TEXT    NOT NULL DEFAULT '',
    schema_version INTEGER NOT NULL,
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL,
    PRIMARY KEY (project_id, field_key)
) STRICT;`,
] as const;

export function bootstrapSqliteSchema(database: SqliteDatabase = sqliteDatabase): void {
  for (const statement of sqliteSchemaStatements) {
    database.exec(statement);
  }
}

export function bootstrapSchema(database: SqliteDatabase = sqliteDatabase): Promise<void> {
  bootstrapSqliteSchema(database);
  return serial(async () => {
    await metaClient.command({ query: 'CREATE DATABASE IF NOT EXISTS data;' });
  });
}
