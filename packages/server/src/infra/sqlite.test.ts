import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isSqliteConstraintConflict, openSqliteDatabase, type SqliteDatabase } from './sqlite.js';

const databases: SqliteDatabase[] = [];
const temporaryDirectories: string[] = [];

function makeDatabase(label: string): SqliteDatabase {
  const dataDir = mkdtempSync(join(tmpdir(), `collect-log-${label}-`));
  const database = openSqliteDatabase(dataDir);
  temporaryDirectories.push(dataDir);
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

describe('SQLite infrastructure', () => {
  it('opens the fixed app.db path and enables all four required PRAGMAs', () => {
    const database = makeDatabase('pragmas');

    expect(database.databasePath).toBe(join(temporaryDirectories[0] ?? '', 'sqlite3', 'app.db'));
    expect(database.prepare<{ journal_mode: string }>('PRAGMA journal_mode;').get()).toEqual({
      journal_mode: 'wal',
    });
    expect(database.prepare<{ foreign_keys: number }>('PRAGMA foreign_keys;').get()).toEqual({
      foreign_keys: 1,
    });
    expect(database.prepare<{ timeout: number }>('PRAGMA busy_timeout;').get()).toEqual({
      timeout: 5_000,
    });
    expect(database.prepare<{ synchronous: number }>('PRAGMA synchronous;').get()).toEqual({
      synchronous: 1,
    });
  });

  it('rolls back failed BEGIN IMMEDIATE transactions and identifies unique conflicts', () => {
    const database = makeDatabase('transactions');
    database.exec('CREATE TABLE values_test (id TEXT PRIMARY KEY, value TEXT UNIQUE) STRICT;');
    const insert = database.prepare('INSERT INTO values_test (id, value) VALUES (?, ?)');

    expect(() =>
      database.transaction(() => {
        insert.run('rolled-back', 'first');
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(
      database.prepare<{ count: number }>('SELECT count(*) AS count FROM values_test').get(),
    ).toEqual({ count: 0 });

    insert.run('kept', 'unique');
    let primaryKeyError: unknown;
    let uniqueError: unknown;
    try {
      insert.run('kept', 'other');
    } catch (error) {
      primaryKeyError = error;
    }
    try {
      insert.run('other', 'unique');
    } catch (error) {
      uniqueError = error;
    }
    expect(isSqliteConstraintConflict(primaryKeyError)).toBe(true);
    expect(isSqliteConstraintConflict(uniqueError)).toBe(true);
  });

  it('supports nested transactions with SAVEPOINT-scoped rollback', () => {
    const database = makeDatabase('nested-transactions');
    database.exec('CREATE TABLE nested_test (id TEXT PRIMARY KEY) STRICT;');
    const insert = database.prepare('INSERT INTO nested_test (id) VALUES (?)');

    database.transaction(() => {
      insert.run('outer-before');
      expect(() =>
        database.transaction(() => {
          insert.run('inner-rolled-back');
          throw new Error('rollback inner');
        }),
      ).toThrow('rollback inner');
      database.transaction(() => insert.run('inner-committed'));
      insert.run('outer-after');
    });

    expect(
      database.prepare<{ id: string }>('SELECT id FROM nested_test ORDER BY id').all(),
    ).toEqual([{ id: 'inner-committed' }, { id: 'outer-after' }, { id: 'outer-before' }]);

    expect(() =>
      database.transaction(() => {
        insert.run('outer-rolled-back');
        database.transaction(() => insert.run('inner-released'));
        throw new Error('rollback outer');
      }),
    ).toThrow('rollback outer');
    expect(
      database.prepare<{ id: string }>('SELECT id FROM nested_test ORDER BY id').all(),
    ).toEqual([{ id: 'inner-committed' }, { id: 'outer-after' }, { id: 'outer-before' }]);
  });

  it('recovers the WAL after an abnormal process exit without exposing partial writes', () => {
    const database = makeDatabase('wal-recovery');
    database.exec('CREATE TABLE wal_test (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;');
    database.prepare('INSERT INTO wal_test (id, value) VALUES (?, ?)').run('committed', 'visible');

    const childScript = `
      import { DatabaseSync } from 'node:sqlite';
      const database = new DatabaseSync(process.argv[1]);
      database.exec('PRAGMA journal_mode = WAL;');
      database.exec('PRAGMA busy_timeout = 5000;');
      database.exec('BEGIN IMMEDIATE;');
      const insert = database.prepare('INSERT INTO wal_test (id, value) VALUES (?, ?)');
      insert.run('partial-a', 'hidden');
      insert.run('partial-b', 'hidden');
      process.exit(86);
    `;
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', childScript, database.databasePath],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(child.status, child.stderr).toBe(86);

    const recovered = openSqliteDatabase(temporaryDirectories[0] ?? '');
    databases.push(recovered);
    const rows = recovered
      .prepare<{ id: string; value: string }>('SELECT id, value FROM wal_test ORDER BY id')
      .all();

    expect(rows).toEqual([{ id: 'committed', value: 'visible' }]);
    recovered.quickCheck();
  });
});
