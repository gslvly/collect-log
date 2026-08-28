import { describe, expect, it } from 'vitest';

import { AppError } from '../../errors.js';
import { parseEnvelope } from './envelope.js';

const validEnvelope = {
  p: 'prj_01KABCDEF0123456789ABCDEFG',
  t: 1_756_012_830_123,
  n: 'a3f9c2d1b7e40851',
  s: 'a'.repeat(64),
  d: '{"occurredAt":1756012830123,"data":{}}',
};

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : undefined;
  }
}

describe('ingest envelope parsing', () => {
  it('keeps d as the exact raw signed string', () => {
    const body = JSON.stringify(validEnvelope);
    expect(parseEnvelope(body)).toEqual(validEnvelope);
  });

  it('distinguishes malformed JSON from an invalid envelope shape', () => {
    expect(errorCode(() => parseEnvelope('{'))).toBe('INVALID_JSON');
    expect(errorCode(() => parseEnvelope('[]'))).toBe('INVALID_ENVELOPE');
    expect(errorCode(() => parseEnvelope(JSON.stringify({ ...validEnvelope, p: 1 })))).toBe(
      'INVALID_ENVELOPE',
    );
  });

  it('requires a 16-character lowercase hex nonce and 64-character lowercase hex signature', () => {
    expect(
      errorCode(() => parseEnvelope(JSON.stringify({ ...validEnvelope, n: 'A'.repeat(16) }))),
    ).toBe('INVALID_ENVELOPE');
    expect(
      errorCode(() => parseEnvelope(JSON.stringify({ ...validEnvelope, s: 'A'.repeat(64) }))),
    ).toBe('INVALID_ENVELOPE');
  });
});
