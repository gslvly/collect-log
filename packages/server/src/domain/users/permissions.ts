import { AppError } from '../../errors.js';
import type { UserRole } from './types.js';

export function assertCanCreateUser(operatorRole: UserRole, requestedRole: UserRole): void {
  const allowed =
    (operatorRole === 'super_admin' && (requestedRole === 'admin' || requestedRole === 'user')) ||
    (operatorRole === 'admin' && requestedRole === 'user');
  if (!allowed) {
    throw new AppError('FORBIDDEN', 'Insufficient permissions to create this account role');
  }
}

export function assertCanModifyUser(operatorRole: UserRole, targetRole: UserRole): void {
  const allowed =
    operatorRole === 'super_admin' || (operatorRole === 'admin' && targetRole === 'user');
  if (!allowed) {
    throw new AppError('FORBIDDEN', 'Insufficient permissions to modify this account');
  }
}

export function assertCanDeleteUser(operatorRole: UserRole, targetRole: UserRole): void {
  if (targetRole === 'super_admin') {
    throw new AppError('FORBIDDEN', 'super_admin accounts cannot be deleted');
  }
  assertCanModifyUser(operatorRole, targetRole);
}
