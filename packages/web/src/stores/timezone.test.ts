import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getBrowserTimeZone, TIME_ZONE_STORAGE_KEY, useTimezoneStore } from './timezone.js';

class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();

  get length(): number {
    return this.#items.size;
  }

  clear(): void {
    this.#items.clear();
  }

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
}

const localStorageMock = new MemoryStorage();
vi.stubGlobal('localStorage', localStorageMock);

describe('timezone store', () => {
  beforeEach(() => {
    localStorageMock.clear();
    setActivePinia(createPinia());
  });

  it('defaults to the browser IANA time zone', () => {
    expect(useTimezoneStore().timeZone).toBe(getBrowserTimeZone());
  });

  it('persists a selected IANA time zone and restores it in a new store', () => {
    useTimezoneStore().setTimeZone('Asia/Shanghai');
    expect(localStorageMock.getItem(TIME_ZONE_STORAGE_KEY)).toBe('Asia/Shanghai');

    setActivePinia(createPinia());
    expect(useTimezoneStore().timeZone).toBe('Asia/Shanghai');
  });

  it.each(['Not/AZone', '+08:00'])('rejects stored invalid or offset time zone %s', (stored) => {
    localStorageMock.setItem(TIME_ZONE_STORAGE_KEY, stored);
    setActivePinia(createPinia());

    expect(useTimezoneStore().timeZone).toBe(getBrowserTimeZone());
  });

  it('formats a UTC ISO instant using the selected time zone', () => {
    const timezoneStore = useTimezoneStore();
    timezoneStore.setTimeZone('Asia/Shanghai');

    expect(timezoneStore.formatUtc('2026-08-28T00:00:00.000Z')).toContain('08:00:00');
  });
});
