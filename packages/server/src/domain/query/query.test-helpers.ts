import { expect } from 'vitest';

import { AppError } from '../../errors.js';

export function expectInvalidQuery(action: () => unknown): void {
  try {
    action();
    throw new Error('Expected INVALID_QUERY');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INVALID_QUERY');
  }
}
