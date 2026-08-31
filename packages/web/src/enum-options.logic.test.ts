import { describe, expect, it } from 'vitest';

import {
  canRegisterEnumValue,
  hasNewlyDisabledOption,
  moveEnumOption,
  validateEnumOptions,
} from './enum-options.logic.js';

describe('enum option editing', () => {
  it('requires non-empty unique values, labels, and at least one active option', () => {
    expect(validateEnumOptions([])).toMatchObject({ valid: false, form: expect.any(String) });
    expect(
      validateEnumOptions([
        { value: 'web', label: '', status: 'disabled' },
        { value: 'web', label: 'Browser', status: 'disabled' },
      ]),
    ).toMatchObject({
      valid: false,
      form: expect.stringContaining('启用'),
      items: [
        { value: expect.stringContaining('重复'), label: expect.any(String) },
        { value: expect.stringContaining('重复') },
      ],
    });
    expect(validateEnumOptions([{ value: 'web', label: 'Browser', status: 'active' }])).toEqual({
      valid: true,
      items: [{}],
    });
  });

  it('reorders cloned options without mutating the source', () => {
    const source = [
      { value: 'web', label: 'Browser', status: 'active' as const },
      { value: 'app', label: 'App', status: 'disabled' as const },
    ];
    const moved = moveEnumOption(source, 1, 0);
    expect(moved.map((option) => option.value)).toEqual(['app', 'web']);
    expect(source.map((option) => option.value)).toEqual(['web', 'app']);
  });

  it('detects explicit disabling and rejects unregistrable historical values', () => {
    const existing = [{ value: 'web', label: 'Browser', status: 'active' as const }];
    expect(
      hasNewlyDisabledOption(existing, [{ value: 'web', label: 'Browser', status: 'disabled' }]),
    ).toBe(true);
    expect(canRegisterEnumValue('web')).toBe(true);
    expect(canRegisterEnumValue('')).toBe(false);
    expect(canRegisterEnumValue('line\nbreak')).toBe(false);
  });
});
