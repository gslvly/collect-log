import { randomUUID } from 'node:crypto';

import { AppError } from '../../errors.js';
import { metaClient, parameterizedQuery } from '../../infra/clickhouse.js';
import { serial } from '../../infra/serial.js';
import { hashPassword, verifyPassword } from './password.js';
import { assertCanDeleteUser, assertCanModifyUser } from './permissions.js';
import { isUserRole, type UserRecord, type UserRole, type UserStatus } from './types.js';

interface AppUserRow {
  user_id: string;
  username: string;
  password_hash: string;
  role: string;
  status: string;
  version: number | string;
  created_at: string;
  updated_at: string;
}

interface CountRow {
  count: number | string;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role: UserRole;
}

export type BootstrapUserResult = 'already_exists' | 'created' | 'credentials_missing';

function clickHouseDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function parseRole(role: string): UserRole {
  if (role === 'super_admin' || role === 'admin' || role === 'user') {
    return role;
  }
  throw new Error(`Invalid role stored in meta.app_users: ${role}`);
}

function parseStatus(status: string): UserStatus {
  if (status === 'active' || status === 'disabled') {
    return status;
  }
  throw new Error(`Invalid status stored in meta.app_users: ${status}`);
}

function mapUser(row: AppUserRow): UserRecord {
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`Invalid version stored in meta.app_users for ${row.username}`);
  }

  return {
    userId: row.user_id,
    username: row.username,
    passwordHash: row.password_hash,
    role: parseRole(row.role),
    status: parseStatus(row.status),
    version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function insertUser(row: AppUserRow): Promise<void> {
  await metaClient.insert({
    table: 'meta.app_users',
    values: [row],
    format: 'JSONEachRow',
  });
}

async function findUserByUsername(username: string): Promise<UserRecord | null> {
  const rows = await parameterizedQuery<AppUserRow>({
    client: metaClient,
    query: `SELECT *
FROM meta.app_users FINAL
WHERE username = {username:String}`,
    params: { username },
  });
  return rows[0] === undefined ? null : mapUser(rows[0]);
}

function nextVersionRow(
  current: UserRecord,
  changes: Partial<Pick<AppUserRow, 'password_hash' | 'status'>>,
): AppUserRow {
  return {
    user_id: current.userId,
    username: current.username,
    password_hash: changes.password_hash ?? current.passwordHash,
    role: current.role,
    status: changes.status ?? current.status,
    version: current.version + 1,
    created_at: current.createdAt,
    updated_at: clickHouseDateTime(new Date()),
  };
}

export class UserRepository {
  async findActiveByUsername(username: string): Promise<UserRecord | null> {
    const rows = await parameterizedQuery<AppUserRow>({
      client: metaClient,
      query: `SELECT *
FROM meta.app_users FINAL
WHERE username = {username:String}
  AND status = 'active';`,
      params: { username },
    });
    return rows[0] === undefined ? null : mapUser(rows[0]);
  }

  findByUsername(username: string): Promise<UserRecord | null> {
    return findUserByUsername(username);
  }

  async list(): Promise<UserRecord[]> {
    const rows = await parameterizedQuery<AppUserRow>({
      client: metaClient,
      query: `SELECT *
FROM meta.app_users FINAL
ORDER BY username`,
      params: {},
    });
    return rows.map(mapUser);
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    if (!isUserRole(input.role)) {
      throw new AppError('INVALID_JSON', 'Account role is invalid');
    }
    const passwordHash = await hashPassword(input.password);

    return serial(async () => {
      if ((await findUserByUsername(input.username)) !== null) {
        throw new AppError('USERNAME_EXISTS', `Username "${input.username}" already exists`);
      }

      const now = clickHouseDateTime(new Date());
      const row: AppUserRow = {
        user_id: randomUUID(),
        username: input.username,
        password_hash: passwordHash,
        role: input.role,
        status: 'active',
        version: 1,
        created_at: now,
        updated_at: now,
      };
      await insertUser(row);
      return mapUser(row);
    });
  }

  changeOwnPassword(username: string, currentPassword: string, newPassword: string): Promise<void> {
    return serial(async () => {
      const current = await this.findActiveByUsername(username);
      if (current === null) {
        throw new AppError('USER_NOT_FOUND', `User "${username}" was not found`);
      }
      if (!(await verifyPassword(current.passwordHash, currentPassword))) {
        throw new AppError('INVALID_CREDENTIALS', 'Invalid username or password');
      }

      const passwordHash = await hashPassword(newPassword);
      await insertUser(nextVersionRow(current, { password_hash: passwordHash }));
    });
  }

  resetPassword(
    username: string,
    newPassword: string,
    operatorRole: UserRole,
  ): Promise<UserRecord> {
    return serial(async () => {
      const current = await findUserByUsername(username);
      if (current === null) {
        throw new AppError('USER_NOT_FOUND', `User "${username}" was not found`);
      }
      assertCanModifyUser(operatorRole, current.role);

      const passwordHash = await hashPassword(newPassword);
      const row = nextVersionRow(current, { password_hash: passwordHash });
      await insertUser(row);
      return mapUser(row);
    });
  }

  setStatus(username: string, status: UserStatus, operatorRole: UserRole): Promise<UserRecord> {
    return serial(async () => {
      const current = await findUserByUsername(username);
      if (current === null) {
        throw new AppError('USER_NOT_FOUND', `User "${username}" was not found`);
      }
      assertCanModifyUser(operatorRole, current.role);
      if (current.status === status) {
        return current;
      }

      if (current.role === 'super_admin' && current.status === 'active' && status === 'disabled') {
        const rows = await parameterizedQuery<CountRow>({
          client: metaClient,
          query: `SELECT count() AS count
FROM meta.app_users FINAL
WHERE role = {role:String}
  AND status = {status:String}`,
          params: { role: 'super_admin', status: 'active' },
        });
        if (Number(rows[0]?.count ?? 0) <= 1) {
          throw new AppError('LAST_SUPER_ADMIN', 'The last active super_admin cannot be disabled');
        }
      }

      const row = nextVersionRow(current, { status });
      await insertUser(row);
      return mapUser(row);
    });
  }

  delete(username: string, operatorRole: UserRole): Promise<UserRecord> {
    return serial(async () => {
      const current = await findUserByUsername(username);
      if (current === null) {
        throw new AppError('USER_NOT_FOUND', `User "${username}" was not found`);
      }
      assertCanDeleteUser(operatorRole, current.role);

      await metaClient.command({
        query: 'DELETE FROM meta.app_users WHERE username = {username:String}',
        query_params: { username },
        clickhouse_settings: { mutations_sync: '2' },
      });
      return current;
    });
  }

  bootstrapSuperAdmin(username?: string, password?: string): Promise<BootstrapUserResult> {
    return serial(async () => {
      const superAdmins = await parameterizedQuery<Pick<AppUserRow, 'username'>>({
        client: metaClient,
        query: `SELECT username
FROM meta.app_users FINAL
WHERE role = {role:String}
LIMIT 1`,
        params: { role: 'super_admin' },
      });
      if (superAdmins.length > 0) {
        return 'already_exists';
      }
      if (username === undefined || password === undefined) {
        return 'credentials_missing';
      }
      if ((await findUserByUsername(username)) !== null) {
        throw new AppError('USERNAME_EXISTS', `Username "${username}" already exists`);
      }

      const now = clickHouseDateTime(new Date());
      await insertUser({
        user_id: randomUUID(),
        username,
        password_hash: await hashPassword(password),
        role: 'super_admin',
        status: 'active',
        version: 1,
        created_at: now,
        updated_at: now,
      });
      return 'created';
    });
  }
}

export const userRepository = new UserRepository();
