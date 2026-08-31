import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteDatabase, type SqliteDatabase } from '../infra/sqlite.js';
import { bootstrapSqliteSchema } from './schema.js';

const databases: SqliteDatabase[] = [];
const temporaryDirectories: string[] = [];

function makeDatabase(): SqliteDatabase {
  const dataDir = mkdtempSync(join(tmpdir(), 'collect-log-schema-migration-'));
  temporaryDirectories.push(dataDir);
  const database = openSqliteDatabase(dataDir);
  databases.push(database);
  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  for (const dataDir of temporaryDirectories.splice(0)) {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('SQLite schema bootstrap', () => {
  it('migrates the transitional number CHECK idempotently and preserves every tombstone', () => {
    const database = makeDatabase();
    database.exec(`CREATE TABLE collect_tables
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
) STRICT;
CREATE TABLE collect_fields
(
    project_id     TEXT    NOT NULL REFERENCES collect_tables(project_id),
    field_key      TEXT    NOT NULL,
    label          TEXT    NOT NULL,
    type           TEXT    NOT NULL CHECK (type IN ('string', 'boolean', 'number')),
    required       INTEGER NOT NULL CHECK (required IN (0, 1)),
    description    TEXT    NOT NULL DEFAULT '',
    status         TEXT    NOT NULL
        CHECK (status IN ('active', 'deprecated', 'dropped', 'renamed')),
    renamed_to     TEXT    NOT NULL DEFAULT '',
    schema_version INTEGER NOT NULL,
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL,
    PRIMARY KEY (project_id, field_key)
) STRICT;`);
    const timestamp = '2026-08-30T00:00:00.000Z';
    database
      .prepare(
        `INSERT INTO collect_tables
(project_id, physical_name, display_name, status, schema_version, ingest_secret, created_by, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'prj_old',
        'collect_old',
        'Old table',
        'active',
        1,
        'secret',
        'root',
        timestamp,
        timestamp,
      );
    const insertField = database.prepare(
      `INSERT INTO collect_fields
(project_id, field_key, label, type, required, description, status, renamed_to, schema_version,
 created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertField.run(
      'prj_old',
      'event_name',
      'Event name',
      'string',
      1,
      'active row',
      'active',
      '',
      1,
      timestamp,
      timestamp,
    );
    for (const [fieldKey, status, renamedTo] of [
      ['legacy_score', 'deprecated', ''],
      ['removed_score', 'dropped', ''],
      ['old_score', 'renamed', 'new_score'],
    ] as const) {
      insertField.run(
        'prj_old',
        fieldKey,
        fieldKey,
        'number',
        0,
        `${status} row`,
        status,
        renamedTo,
        2,
        timestamp,
        timestamp,
      );
    }

    bootstrapSqliteSchema(database);
    bootstrapSqliteSchema(database);

    expect(
      database
        .prepare<{
          field_key: string;
          type: string;
          status: string;
          description: string;
          renamed_to: string;
        }>(
          `SELECT field_key, type, status, description, renamed_to
FROM collect_fields
ORDER BY field_key`,
        )
        .all(),
    ).toEqual([
      {
        field_key: 'event_name',
        type: 'string',
        status: 'active',
        description: 'active row',
        renamed_to: '',
      },
      {
        field_key: 'legacy_score',
        type: 'float',
        status: 'deprecated',
        description: 'deprecated row',
        renamed_to: '',
      },
      {
        field_key: 'old_score',
        type: 'float',
        status: 'renamed',
        description: 'renamed row',
        renamed_to: 'new_score',
      },
      {
        field_key: 'removed_score',
        type: 'float',
        status: 'dropped',
        description: 'dropped row',
        renamed_to: '',
      },
    ]);

    const insertNewField = database.prepare(
      `INSERT INTO collect_fields
(project_id, field_key, label, type, required, status, schema_version, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const type of ['enum', 'integer', 'float', 'datetime']) {
      expect(() =>
        insertNewField.run(
          'prj_old',
          `new_${type}`,
          type,
          type,
          0,
          'active',
          3,
          timestamp,
          timestamp,
        ),
      ).not.toThrow();
    }
    expect(() =>
      insertNewField.run(
        'prj_old',
        'old_number',
        'Old number',
        'number',
        0,
        'active',
        3,
        timestamp,
        timestamp,
      ),
    ).toThrow();
  });

  it('creates the option table with an effective cascading composite foreign key', () => {
    const database = makeDatabase();
    bootstrapSqliteSchema(database);
    const timestamp = '2026-08-30T00:00:00.000Z';
    database
      .prepare(
        `INSERT INTO collect_tables
(project_id, physical_name, display_name, status, schema_version, ingest_secret, created_by, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'prj_options',
        'collect_options',
        'Options',
        'active',
        1,
        'secret',
        'root',
        timestamp,
        timestamp,
      );
    database
      .prepare(
        `INSERT INTO collect_fields
(project_id, field_key, label, type, required, status, schema_version, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('prj_options', 'channel', 'Channel', 'enum', 0, 'active', 1, timestamp, timestamp);
    database
      .prepare(
        `INSERT INTO collect_field_options
(project_id, field_key, value, label, status, sort_order, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('prj_options', 'channel', 'web', 'Web', 'active', 0, timestamp, timestamp);

    expect(database.prepare<{ foreign_keys: number }>('PRAGMA foreign_keys;').get()).toEqual({
      foreign_keys: 1,
    });
    database
      .prepare('DELETE FROM collect_fields WHERE project_id = ? AND field_key = ?')
      .run('prj_options', 'channel');
    expect(
      database
        .prepare<{ count: number }>('SELECT count(*) AS count FROM collect_field_options')
        .get(),
    ).toEqual({ count: 0 });
  });
});
