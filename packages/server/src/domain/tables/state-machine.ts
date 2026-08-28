import { AppError } from '../../errors.js';
import type { TableStatus } from './types.js';

const ALLOWED_TRANSITIONS: Readonly<Record<TableStatus, readonly TableStatus[]>> = {
  creating: ['active', 'failed'],
  active: ['disabled', 'archived'],
  disabled: ['active', 'archived'],
  archived: ['active'],
  failed: ['creating', 'archived'],
};

export function canTransitionTableStatus(from: TableStatus, to: TableStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTableStatusTransition(from: TableStatus, to: TableStatus): void {
  if (!canTransitionTableStatus(from, to)) {
    throw new AppError(
      'TABLE_STATE_CONFLICT',
      `Table status cannot transition from ${from} to ${to}`,
    );
  }
}
