import { describe, expect, it } from 'vitest';

import { assertTableStatusTransition, canTransitionTableStatus } from './state-machine.js';
import { TABLE_STATUSES, type TableStatus } from './types.js';

const allowed: Readonly<Record<TableStatus, readonly TableStatus[]>> = {
  creating: ['active', 'failed'],
  active: ['disabled', 'archived'],
  disabled: ['active', 'archived'],
  archived: ['active'],
  failed: ['creating', 'archived'],
};

describe('table status state machine', () => {
  it('allows exactly the transitions listed in DESIGN 5.1', () => {
    for (const from of TABLE_STATUSES) {
      for (const to of TABLE_STATUSES) {
        expect(canTransitionTableStatus(from, to)).toBe(allowed[from].includes(to));
      }
    }
  });

  it('maps every disallowed transition to TABLE_STATE_CONFLICT', () => {
    for (const from of TABLE_STATUSES) {
      for (const to of TABLE_STATUSES) {
        if (allowed[from].includes(to)) {
          expect(() => assertTableStatusTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertTableStatusTransition(from, to)).toThrow(
            expect.objectContaining({ code: 'TABLE_STATE_CONFLICT' }),
          );
        }
      }
    }
  });
});
