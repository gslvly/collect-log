export type Role = 'super_admin' | 'admin' | 'user';

export const ROLES = ['user', 'admin', 'super_admin'] as const satisfies readonly Role[];

export type Permission =
  | 'viewTables'
  | 'queryData'
  | 'exportData'
  | 'changeOwnPassword'
  | 'createTable'
  | 'readTableTemplates'
  | 'manageFields'
  | 'destructiveFieldChanges'
  | 'manageIngestSecret'
  | 'changeTableStatus'
  | 'deleteTable'
  | 'createUser'
  | 'createAdmin';

const PERMISSION_MATRIX = {
  viewTables: ['user', 'admin', 'super_admin'],
  queryData: ['user', 'admin', 'super_admin'],
  exportData: ['user', 'admin', 'super_admin'],
  changeOwnPassword: ['user', 'admin', 'super_admin'],
  createTable: ['admin', 'super_admin'],
  readTableTemplates: ['admin', 'super_admin'],
  manageFields: ['admin', 'super_admin'],
  destructiveFieldChanges: ['admin', 'super_admin'],
  manageIngestSecret: ['admin', 'super_admin'],
  changeTableStatus: ['admin', 'super_admin'],
  deleteTable: ['super_admin'],
  createUser: ['admin', 'super_admin'],
  createAdmin: ['super_admin'],
} as const satisfies Record<Permission, readonly Role[]>;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSION_MATRIX[permission] as readonly Role[]).includes(role);
}

export function canDeleteUser(actorRole: Role, targetRole: Role): boolean {
  if (targetRole === 'super_admin') {
    return false;
  }
  if (targetRole === 'admin') {
    return actorRole === 'super_admin';
  }
  return actorRole === 'admin' || actorRole === 'super_admin';
}

export function canAccessRoles(role: Role, requiredRoles?: readonly Role[]): boolean {
  return requiredRoles === undefined || requiredRoles.includes(role);
}
