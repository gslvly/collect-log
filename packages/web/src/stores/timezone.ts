import { defineStore } from 'pinia';

export const TIME_ZONE_STORAGE_KEY = 'collect-log.timeZone';

const FALLBACK_TIME_ZONES = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
] as const;

function readStoredTimeZone(): string | null {
  try {
    return localStorage.getItem(TIME_ZONE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistTimeZone(timeZone: string): void {
  try {
    localStorage.setItem(TIME_ZONE_STORAGE_KEY, timeZone);
  } catch {
    // Display preferences may stay in memory when storage is unavailable.
  }
}

export function isValidIanaTimeZone(timeZone: string): boolean {
  if (timeZone === '') {
    return false;
  }

  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
    return !resolved.startsWith('+') && !resolved.startsWith('-');
  } catch {
    return false;
  }
}

export function getBrowserTimeZone(): string {
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidIanaTimeZone(browserTimeZone) ? browserTimeZone : 'UTC';
}

export function getSupportedTimeZones(currentTimeZone?: string): string[] {
  let supported: string[];
  try {
    supported = Intl.supportedValuesOf('timeZone');
  } catch {
    supported = [...FALLBACK_TIME_ZONES];
  }

  const candidates = [currentTimeZone, 'UTC', ...supported].filter(
    (value): value is string => value !== undefined && isValidIanaTimeZone(value),
  );
  return [...new Set(candidates)];
}

function getInitialTimeZone(): string {
  const browserTimeZone = getBrowserTimeZone();
  const storedTimeZone = readStoredTimeZone();
  return storedTimeZone !== null && isValidIanaTimeZone(storedTimeZone)
    ? storedTimeZone
    : browserTimeZone;
}

export function formatUtcIso(
  utcIso: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    ...options,
    timeZone,
  }).format(new Date(utcIso));
}

export const useTimezoneStore = defineStore('timezone', {
  state: () => ({
    timeZone: getInitialTimeZone(),
  }),
  actions: {
    setTimeZone(timeZone: string): void {
      if (!isValidIanaTimeZone(timeZone)) {
        throw new RangeError(`Invalid IANA time zone: ${timeZone}`);
      }
      this.timeZone = timeZone;
      persistTimeZone(timeZone);
    },
    formatUtc(utcIso: string, options: Intl.DateTimeFormatOptions = {}): string {
      return formatUtcIso(utcIso, this.timeZone, options);
    },
  },
});
