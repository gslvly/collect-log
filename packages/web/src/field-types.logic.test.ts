import { describe, expect, it } from 'vitest';

import {
  FIELD_NAME_HELP,
  FIELD_TYPE_DESCRIPTIONS,
  MAX_SAFE_FIELD_NUMBER,
  MIN_SAFE_FIELD_NUMBER,
  getFieldTypeNotice,
  isSafeFieldNumber,
} from './field-types.logic.js';

describe('field type presentation and numeric limits', () => {
  it('shows notices for all value-bearing types while leaving boolean empty', () => {
    expect(getFieldTypeNotice('string', { maxStringLength: 8_192 })).toContain('8192 UTF-8 字节');
    expect(getFieldTypeNotice('string')).toContain('由服务端配置');
    expect(getFieldTypeNotice('enum')).toContain('已启用的选项');
    expect(getFieldTypeNotice('integer')).toContain('大整数 ID');
    expect(getFieldTypeNotice('integer')).toContain('2^53');
    expect(getFieldTypeNotice('float')).toContain('不支持等值筛选');
    expect(getFieldTypeNotice('datetime')).toContain('Unix 毫秒');
    expect(getFieldTypeNotice('boolean')).toBe('');
    expect(FIELD_NAME_HELP).toContain('查询结果表头');
    expect(FIELD_NAME_HELP).toContain('字段 Key');
    expect(Object.keys(FIELD_TYPE_DESCRIPTIONS)).toEqual([
      'string',
      'enum',
      'boolean',
      'integer',
      'float',
      'datetime',
    ]);
  });

  it('accepts finite values at both safe boundaries and rejects unsafe values', () => {
    for (const value of [MIN_SAFE_FIELD_NUMBER, -12.5, 0, 12.5, MAX_SAFE_FIELD_NUMBER]) {
      expect(isSafeFieldNumber(value)).toBe(true);
    }
    for (const value of [
      MIN_SAFE_FIELD_NUMBER - 1,
      MAX_SAFE_FIELD_NUMBER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '12.5',
    ]) {
      expect(isSafeFieldNumber(value)).toBe(false);
    }
  });
});
