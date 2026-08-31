import type { TimeRange } from '../../api/query.js';

interface DateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getZonedParts(timestamp: number, timeZone: string): DateTimeParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
    second: Number(values.get('second')),
  };
}

function partsAsUtc(parts: DateTimeParts, milliseconds = 0): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    milliseconds,
  );
}

export function timestampToPickerDate(timestamp: number, timeZone: string): Date {
  const parts = getZonedParts(timestamp, timeZone);
  return new Date(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    new Date(timestamp).getUTCMilliseconds(),
  );
}

export function pickerDateToTimestamp(date: Date, timeZone: string): number {
  const wallParts: DateTimeParts = {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
  };
  const milliseconds = date.getMilliseconds();
  const wallTimestamp = partsAsUtc(wallParts, milliseconds);
  let candidate = wallTimestamp;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidateParts = getZonedParts(candidate, timeZone);
    const difference = wallTimestamp - partsAsUtc(candidateParts, milliseconds);
    if (difference === 0) {
      return candidate;
    }
    candidate += difference;
  }
  return candidate;
}

export function timeRangeToPickerRange(range: TimeRange, timeZone: string): [Date, Date] {
  return [timestampToPickerDate(range.start, timeZone), timestampToPickerDate(range.end, timeZone)];
}

export function pickerRangeToTimeRange(
  range: [Date, Date] | null,
  timeZone: string,
): TimeRange | null {
  if (range === null) {
    return null;
  }
  return {
    start: pickerDateToTimestamp(range[0], timeZone),
    end: pickerDateToTimestamp(range[1], timeZone),
  };
}
