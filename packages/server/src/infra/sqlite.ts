import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementResultingChanges,
  type StatementSync,
} from 'node:sqlite';

import { env } from '../config/env.js';

export const SQLITE_CONSTRAINT_PRIMARYKEY = 1_555;
export const SQLITE_CONSTRAINT_UNIQUE = 2_067;

interface SqliteError {
  code?: unknown;
  errcode?: unknown;
}

export function isSqliteConstraintConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const { code, errcode } = error as SqliteError;
  return (
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    (code === 'ERR_SQLITE_ERROR' &&
      (errcode === SQLITE_CONSTRAINT_PRIMARYKEY || errcode === SQLITE_CONSTRAINT_UNIQUE))
  );
}

export class PreparedStatement<Row extends object = Record<string, unknown>> {
  constructor(private readonly statement: StatementSync) {}

  get(...parameters: SQLInputValue[]): Row | undefined {
    return this.statement.get(...parameters) as Row | undefined;
  }

  all(...parameters: SQLInputValue[]): Row[] {
    return this.statement.all(...parameters) as Row[];
  }

  run(...parameters: SQLInputValue[]): StatementResultingChanges {
    return this.statement.run(...parameters);
  }
}

export class SqliteDatabase {
  readonly databasePath: string;
  private readonly database: DatabaseSync;
  private transactionDepth = 0;

  constructor(dataDir: string) {
    const sqliteDirectory = join(dataDir, 'sqlite3');
    mkdirSync(sqliteDirectory, { recursive: true, mode: 0o700 });
    this.databasePath = join(sqliteDirectory, 'app.db');
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec('PRAGMA journal_mode = WAL;');
    this.database.exec('PRAGMA foreign_keys = ON;');
    this.database.exec('PRAGMA busy_timeout = 5000;');
    this.database.exec('PRAGMA synchronous = NORMAL;');
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare<Row extends object = Record<string, unknown>>(sql: string): PreparedStatement<Row> {
    return new PreparedStatement<Row>(this.database.prepare(sql));
  }

  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) {
      return this.nestedTransaction(operation);
    }

    this.database.exec('BEGIN IMMEDIATE;');
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.database.exec('COMMIT;');
      return result;
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec('ROLLBACK;');
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private nestedTransaction<T>(operation: () => T): T {
    const savepoint = `nested_transaction_${this.transactionDepth}`;
    this.database.exec(`SAVEPOINT ${savepoint};`);
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.database.exec(`RELEASE SAVEPOINT ${savepoint};`);
      return result;
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint};`);
        this.database.exec(`RELEASE SAVEPOINT ${savepoint};`);
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  quickCheck(): void {
    const row = this.prepare<{ quick_check: string }>('PRAGMA quick_check;').get();
    if (row?.quick_check !== 'ok') {
      throw new Error(`SQLite quick_check failed: ${row?.quick_check ?? 'no result'}`);
    }
  }

  close(): void {
    if (this.database.isOpen) {
      this.database.close();
    }
  }
}

export function openSqliteDatabase(dataDir: string): SqliteDatabase {
  return new SqliteDatabase(dataDir);
}

export const sqliteDatabase = openSqliteDatabase(env.DATA_DIR);

export function prepare<Row extends object = Record<string, unknown>>(
  sql: string,
): PreparedStatement<Row> {
  return sqliteDatabase.prepare<Row>(sql);
}

export function transaction<T>(operation: () => T): T {
  return sqliteDatabase.transaction(operation);
}

export function pingSqlite(): Promise<void> {
  return Promise.resolve().then(() => sqliteDatabase.quickCheck());
}

export function closeSqliteDatabase(): void {
  sqliteDatabase.close();
}
