export const USER_ROLES = ['super_admin', 'admin', 'user'] as const;

export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'disabled'] as const;

export type UserStatus = (typeof USER_STATUSES)[number];

export interface UserRecord {
  userId: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUser {
  userId: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && USER_ROLES.includes(value as UserRole);
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    userId: user.userId,
    username: user.username,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
