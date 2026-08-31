import { createHash } from 'node:crypto';

import { AppError } from '../../errors.js';
import type { Condition, CursorPayload, QueryOrder, TimeRange } from './types.js';

const CURSOR_MESSAGE = 'Cursor does not match the current query, please restart pagination';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) {
        result[key] = canonicalize(child);
      }
    }
    return result;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function queryFingerprint(input: {
  projectId: string;
  range: TimeRange;
  filter?: Condition | undefined;
  includeFields: readonly string[];
  order: QueryOrder;
  schemaVersion: number;
}): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex').slice(0, 16);
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function invalidCursor(): never {
  throw new AppError('INVALID_QUERY', CURSOR_MESSAGE);
}

export function decodeCursor(cursor: string, expectedFingerprint: string): CursorPayload {
  if (!BASE64URL_PATTERN.test(cursor)) {
    return invalidCursor();
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return invalidCursor();
    }
    const { at, id, fp } = parsed as Record<string, unknown>;
    if (
      Object.keys(parsed).length !== 3 ||
      !Number.isSafeInteger(at) ||
      !Number.isFinite(new Date(at as number).getTime()) ||
      typeof id !== 'string' ||
      !UUID_PATTERN.test(id) ||
      typeof fp !== 'string' ||
      !FINGERPRINT_PATTERN.test(fp) ||
      fp !== expectedFingerprint
    ) {
      return invalidCursor();
    }
    return { at: at as number, id, fp };
  } catch {
    return invalidCursor();
  }
}
