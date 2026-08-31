import { describe, expect, it } from 'vitest';

import { classifyClickHouseError } from '../../infra/clickhouse.js';

describe('ClickHouse error classification', () => {
  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND'])(
    'classifies %s as unavailable',
    (code) => {
      expect(classifyClickHouseError(Object.assign(new Error('network error'), { code }))).toBe(
        'unavailable',
      );
    },
  );

  it('classifies connection messages, aborts, nested causes, limits, and server errors', () => {
    expect(classifyClickHouseError(new Error('socket hang up'))).toBe('unavailable');
    expect(
      classifyClickHouseError(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    ).toBe('unavailable');
    expect(
      classifyClickHouseError(
        Object.assign(new Error('fetch failed'), {
          cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
        }),
      ),
    ).toBe('unavailable');
    for (const code of [159, 160, 241, 396]) {
      expect(classifyClickHouseError(Object.assign(new Error('ClickHouse limit'), { code }))).toBe(
        'limit_exceeded',
      );
    }
    expect(classifyClickHouseError(Object.assign(new Error('syntax error'), { code: '62' }))).toBe(
      'server_error',
    );
  });
});
