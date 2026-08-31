import { defineStore } from 'pinia';

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
  try {
    const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof browserTimeZone === 'string' && isValidIanaTimeZone(browserTimeZone)
      ? browserTimeZone
      : 'UTC';
  } catch {
    return 'UTC';
  }
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
  state: () => ({}),
  getters: {
    timeZone: (): string => getBrowserTimeZone(),
  },
  actions: {
    formatUtc(utcIso: string, options: Intl.DateTimeFormatOptions = {}): string {
      return formatUtcIso(utcIso, this.timeZone, options);
    },
  },
});
