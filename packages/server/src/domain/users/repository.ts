import { randomUUID } from 'node:crypto';

import { AppError } from '../../errors.js';
import {
  isSqliteConstraintConflict,
  sqliteDatabase,
  type PreparedStatement,
  type SqliteDatabase,
} from '../../infra/sqlite.js';
import { hashPassword, verifyPassword } from './password.js';
import { assertCanDeleteUser, assertCanModifyUser } from './permissions.js';
import { isUserRole, type UserRecord, type UserRole, type UserStatus } from './types.js';

interface AppUserRow {
  user_id: string;
  username: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface CountRow {
  count: number;
}

interface UserStatements {
  findActiveByUsername: PreparedStatement<AppUserRow>;
  findByUsername: PreparedStatement<AppUserRow>;
  list: PreparedStatement<AppUserRow>;
  insert: PreparedStatement;
  updatePassword: PreparedStatement;
  updateStatus: PreparedStatement;
  countActiveSuperAdmins: PreparedStatement<CountRow>;
  deleteByUsername: PreparedStatement;
  findSuperAdmin: PreparedStatement<Pick<AppUserRow, 'username'>>;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role: UserRole;
}

export type BootstrapUserResult = 'already_exists' | 'created' | 'credentials_missing';

function parseRole(role: string): UserRole {
  if (role === 'super_admin' || role === 'admin' || role === 'user') {
    return role;
  }
  throw new Error(`Invalid role stored in app_users: ${role}`);
}

function parseStatus(status: string): UserStatus {
  if (status === 'active' || status === 'disabled') {
    return status;
  }
  throw new Error(`Invalid status stored in app_users: ${status}`);
}

function mapUser(row: AppUserRow): UserRecord {
  return {
    userId: row.user_id,
    username: row.username,
    passwordHash: row.password_hash,
    role: parseRole(row.role),
    status: parseStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function throwUsernameExists(error: unknown, username: string): never {
  if (isSqliteConstraintConflict(error)) {
    throw new AppError('USERNAME_EXISTS', `Username "${username}" already exists`);
  }
  throw error;
}

export class UserRepository {
  private preparedStatements: UserStatements | undefined;

  constructor(private readonly database: SqliteDatabase = sqliteDatabase) {}

  async findActiveByUsername(username: string): Promise<UserRecord | null> {
    return this.findActiveByUsernameSync(username);
  }

  async findByUsername(username: string): Promise<UserRecord | null> {
    return this.findByUsernameSync(username);
  }

  async list(): Promise<UserRecord[]> {
    return this.statements().list.all().map(mapUser);
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    if (!isUserRole(input.role)) {
      throw new AppError('INVALID_JSON', 'Account role is invalid');
    }
    const passwordHash = await hashPassword(input.password);
    const now = new Date().toISOString();
    const row: AppUserRow = {
      user_id: randomUUID(),
      username: input.username,
      password_hash: passwordHash,
      role: input.role,
      status: 'active',
      created_at: now,
      updated_at: now,
    };

    try {
      return this.database.transaction(() => {
        this.insertUser(row);
        return mapUser(row);
      });
    } catch (error) {
      return throwUsernameExists(error, input.username);
    }
  }

  async changeOwnPassword(
    username: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const inspected = this.findActiveByUsernameSync(username);
    if (inspected === null) {
      throw new AppError('USER_NOT_FOUND', `User "${username}" was not found`);
    }
    if (!(await verifyPassword(inspected.passwordHash, currentPassword))) {
      throw new AppError('INVALID_CREDENTIALS', 'Invalid username or password');
    }
    const passwordHash = await hashPassword(newPassword);

    this.database.transaction(() => {
      const current = this.findActiveByUsernameSync(username);
      if (current === null) {
        throw new AppError('USER_NOT_FOUND', `User "${username}" was not found`);
      }
      if (current.passwordHash !== inspected.passwordHash) {
        throw new AppError('INVALID_CREDENTIALS', 'Invalid username or password');
      }
      this.updatePassword(username, passwordHash);
    });
  }

  async resetPassword(
    username: string,
    newPassword: string,
    operatorRole: UserRole,
  ): Promise<UserRecord> {
    const inspected = this.findByUsernameSync(username);
    if (inspected === null) {
      throw new AppError('USER_NOT_FOUND', `User "${username}" was not found`);
    }
    assertCanModifyUser(operatorRole, inspected.role);
    const passwordHash = await hashPassword(newPassword);
    return this.database.transaction(() => {
      const current = this.findByUsernameSync(username);
      if (current === null) {
        throw new AppError('USER_NOT_FOUND', `User "${username}" was not found`);
      }
      assertCanModifyUser(operatorRole, current.role);

      const updatedAt = new Date().toISOString();
      this.updatePassword(username, passwordHash, updatedAt);
      return { ...current, passwordHash, updatedAt };
    });
  }

  async setStatus(
    username: string,
    status: UserStatus,
    operatorRole: UserRole,
  ): Promise<UserRecord> {
    return this.database.transaction(() => {
      const current = this.findByUsernameSync(username);
      if (current === null) {
        throw new AppError('USER_NOT_FOUND', `User "${username}" was not found`);
      }
      assertCanModifyUser(operatorRole, current.role);
      if (current.status === status) {
        return current;
      }

      if (current.role === 'super_admin' && current.status === 'active' && status === 'disabled') {
        const count = this.statements().countActiveSuperAdmins.get('super_admin', 'active');
        if ((count?.count ?? 0) <= 1) {
          throw new AppError('LAST_SUPER_ADMIN', 'The last active super_admin cannot be disabled');
        }
      }

      const updatedAt = new Date().toISOString();
      const result = this.statements().updateStatus.run(status, updatedAt, username);
      if (result.changes !== 1) {
        throw new AppError('USER_NOT_FOUND', `User "${username}" was not found`);
      }
      return { ...current, status, updatedAt };
    });
  }

  async delete(username: string, operatorRole: UserRole): Promise<UserRecord> {
    return this.database.transaction(() => {
      const current = this.findByUsernameSync(username);
      if (current === null) {
        throw new AppError('USER_NOT_FOUND', `User "${username}" was not found`);
      }
      assertCanDeleteUser(operatorRole, current.role);

      const result = this.statements().deleteByUsername.run(username);
      if (result.changes !== 1) {
        throw new AppError('USER_NOT_FOUND', `User "${username}" was not found`);
      }
      return current;
    });
  }

  async bootstrapSuperAdmin(username?: string, password?: string): Promise<BootstrapUserResult> {
    if (this.hasSuperAdmin()) {
      return 'already_exists';
    }
    if (username === undefined || password === undefined) {
      return 'credentials_missing';
    }

    const passwordHash = await hashPassword(password);
    try {
      return this.database.transaction(() => {
        if (this.hasSuperAdmin()) {
          return 'already_exists';
        }
        const now = new Date().toISOString();
        this.insertUser({
          user_id: randomUUID(),
          username,
          password_hash: passwordHash,
          role: 'super_admin',
          status: 'active',
          created_at: now,
          updated_at: now,
        });
        return 'created';
      });
    } catch (error) {
      return throwUsernameExists(error, username);
    }
  }

  private statements(): UserStatements {
    this.preparedStatements ??= {
      findActiveByUsername: this.database.prepare<AppUserRow>(`SELECT *
FROM app_users
WHERE username = ? AND status = 'active'`),
      findByUsername: this.database.prepare<AppUserRow>(`SELECT *
FROM app_users
WHERE username = ?`),
      list: this.database.prepare<AppUserRow>(`SELECT *
FROM app_users
ORDER BY username`),
      insert: this.database.prepare(`INSERT INTO app_users
  (user_id, username, password_hash, role, status, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)`),
      updatePassword: this.database.prepare(`UPDATE app_users
SET password_hash = ?, updated_at = ?
WHERE username = ?`),
      updateStatus: this.database.prepare(`UPDATE app_users
SET status = ?, updated_at = ?
WHERE username = ?`),
      countActiveSuperAdmins: this.database.prepare<CountRow>(`SELECT count(*) AS count
FROM app_users
WHERE role = ? AND status = ?`),
      deleteByUsername: this.database.prepare('DELETE FROM app_users WHERE username = ?'),
      findSuperAdmin: this.database.prepare<Pick<AppUserRow, 'username'>>(`SELECT username
FROM app_users
WHERE role = ?
LIMIT 1`),
    };
    return this.preparedStatements;
  }

  private findActiveByUsernameSync(username: string): UserRecord | null {
    const row = this.statements().findActiveByUsername.get(username);
    return row === undefined ? null : mapUser(row);
  }

  private findByUsernameSync(username: string): UserRecord | null {
    const row = this.statements().findByUsername.get(username);
    return row === undefined ? null : mapUser(row);
  }

  private hasSuperAdmin(): boolean {
    return this.statements().findSuperAdmin.get('super_admin') !== undefined;
  }

  private insertUser(row: AppUserRow): void {
    this.statements().insert.run(
      row.user_id,
      row.username,
      row.password_hash,
      row.role,
      row.status,
      row.created_at,
      row.updated_at,
    );
  }

  private updatePassword(
    username: string,
    passwordHash: string,
    updatedAt = new Date().toISOString(),
  ): void {
    const result = this.statements().updatePassword.run(passwordHash, updatedAt, username);
    if (result.changes !== 1) {
      throw new AppError('USER_NOT_FOUND', `User "${username}" was not found`);
    }
  }
}

export const userRepository = new UserRepository();
