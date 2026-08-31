import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatUtcIso,
  getBrowserTimeZone,
  isValidIanaTimeZone,
  useTimezoneStore,
} from './timezone.js';

describe('timezone store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setActivePinia(createPinia());
  });

  it('defaults to the browser IANA time zone', () => {
    expect(useTimezoneStore().timeZone).toBe(getBrowserTimeZone());
  });

  it.each(['Asia/Shanghai', 'America/New_York', 'UTC'])('accepts IANA time zone %s', (timeZone) => {
    expect(isValidIanaTimeZone(timeZone)).toBe(true);
  });

  it.each(['', 'Not/AZone', '+08:00'])('rejects invalid or offset time zone %s', (timeZone) => {
    expect(isValidIanaTimeZone(timeZone)).toBe(false);
  });

  it('falls back to UTC when the browser cannot provide a time zone', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue({
      resolvedOptions: () => ({ timeZone: undefined }),
    } as unknown as Intl.DateTimeFormat);

    expect(getBrowserTimeZone()).toBe('UTC');
    expect(useTimezoneStore().timeZone).toBe('UTC');
  });

  it('formats UTC instants with the browser time zone', () => {
    const utcIso = '2026-08-28T00:00:00.000Z';
    expect(useTimezoneStore().formatUtc(utcIso)).toBe(formatUtcIso(utcIso, getBrowserTimeZone()));
  });
});
