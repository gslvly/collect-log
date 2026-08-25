import { describe, expect, it } from 'vitest';

import {
  assertIdentifier,
  CLICKHOUSE_PING_TIMEOUT_MS,
  clientDefaultSettings,
} from './clickhouse.js';

describe('ClickHouse infrastructure', () => {
  it('never enables async_insert in client default settings', () => {
    for (const settings of Object.values(clientDefaultSettings)) {
      expect(settings).not.toHaveProperty('async_insert');
    }
  });

  it('pins FINAL safety and readonly query limits', () => {
    expect(clientDefaultSettings.meta.optimize_move_to_prewhere_if_final).toBe(0);
    expect(clientDefaultSettings.readonly).toMatchObject({
      optimize_move_to_prewhere_if_final: 0,
      max_execution_time: 10,
      max_memory_usage: '2147483648',
      max_result_rows: '10000',
    });
  });

  it('accepts only safe ClickHouse identifiers', () => {
    expect(assertIdentifier('collect_a8f31c')).toBe('collect_a8f31c');
    expect(assertIdentifier('_record_id')).toBe('_record_id');
    expect(() => assertIdentifier('collect-table')).toThrow('Invalid ClickHouse identifier');
    expect(() => assertIdentifier('1table')).toThrow('Invalid ClickHouse identifier');
    expect(() => assertIdentifier(`a${'b'.repeat(64)}`)).toThrow('Invalid ClickHouse identifier');
  });

  it('uses an independent three-second health probe timeout', () => {
    expect(CLICKHOUSE_PING_TIMEOUT_MS).toBe(3_000);
  });
});
