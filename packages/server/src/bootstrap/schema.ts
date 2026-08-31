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
    type           TEXT    NOT NULL
        CHECK (type IN ('string', 'enum', 'boolean', 'integer', 'float', 'datetime')),
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

const collectFieldOptionsSchemaStatement = `CREATE TABLE IF NOT EXISTS collect_field_options
(
    project_id TEXT    NOT NULL,
    field_key  TEXT    NOT NULL,
    value      TEXT    NOT NULL,
    label      TEXT    NOT NULL,
    status     TEXT    NOT NULL CHECK (status IN ('active', 'disabled')),
    sort_order INTEGER NOT NULL,
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL,
    PRIMARY KEY (project_id, field_key, value),
    FOREIGN KEY (project_id, field_key)
        REFERENCES collect_fields(project_id, field_key) ON DELETE CASCADE
) STRICT;`;

interface SqliteSchemaRow {
  sql: string | null;
}

const collectFieldsV4MigrationStatement = `CREATE TABLE collect_fields_v4_migration
(
    project_id     TEXT    NOT NULL REFERENCES collect_tables(project_id),
    field_key      TEXT    NOT NULL,
    label          TEXT    NOT NULL,
    type           TEXT    NOT NULL
        CHECK (type IN ('string', 'enum', 'boolean', 'integer', 'float', 'datetime')),
    required       INTEGER NOT NULL CHECK (required IN (0, 1)),
    description    TEXT    NOT NULL DEFAULT '',
    status         TEXT    NOT NULL
        CHECK (status IN ('active', 'deprecated', 'dropped', 'renamed')),
    renamed_to     TEXT    NOT NULL DEFAULT '',
    schema_version INTEGER NOT NULL,
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL,
    PRIMARY KEY (project_id, field_key)
) STRICT;`;

const v4FieldTypeCheck =
  "CHECK (type IN ('string', 'enum', 'boolean', 'integer', 'float', 'datetime'))";

function migrateCollectFieldsV4Types(database: SqliteDatabase): void {
  const schema = database
    .prepare<SqliteSchemaRow>(
      `SELECT sql
FROM sqlite_schema
WHERE type = ? AND name = ?`,
    )
    .get('table', 'collect_fields');
  if (schema?.sql?.includes(v4FieldTypeCheck) === true) {
    return;
  }

  database.transaction(() => {
    database.exec(collectFieldsV4MigrationStatement);
    database.exec(`INSERT INTO collect_fields_v4_migration
(
    project_id,
    field_key,
    label,
    type,
    required,
    description,
    status,
    renamed_to,
    schema_version,
    created_at,
    updated_at
)
SELECT
    project_id,
    field_key,
    label,
    CASE type WHEN 'number' THEN 'float' ELSE type END,
    required,
    description,
    status,
    renamed_to,
    schema_version,
    created_at,
    updated_at
FROM collect_fields;`);
    database.exec('DROP TABLE collect_fields;');
    database.exec('ALTER TABLE collect_fields_v4_migration RENAME TO collect_fields;');
  });
}

export function bootstrapSqliteSchema(database: SqliteDatabase = sqliteDatabase): void {
  for (const statement of sqliteSchemaStatements) {
    database.exec(statement);
  }
  migrateCollectFieldsV4Types(database);
  database.exec(collectFieldOptionsSchemaStatement);
}

export function bootstrapSchema(database: SqliteDatabase = sqliteDatabase): Promise<void> {
  bootstrapSqliteSchema(database);
  return serial(async () => {
    await metaClient.command({ query: 'CREATE DATABASE IF NOT EXISTS data;' });
  });
}
