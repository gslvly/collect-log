import { describe, expect, it } from 'vitest';

import { getExportFilename } from './query.js';

describe('query API helpers', () => {
  it('mirrors the server CSV filename format using a UTC timestamp', () => {
    expect(
      getExportFilename('prj_01KABCDEF12345678901234567', Date.parse('2026-08-29T12:34:56.789Z')),
    ).toBe('collect_prj_01KABCDEF12345678901234567_20260829123456.csv');
  });
});
