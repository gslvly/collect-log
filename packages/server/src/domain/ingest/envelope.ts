import { AppError } from '../../errors.js';

export interface IngestEnvelope {
  p: string;
  t: number;
  n: string;
  s: string;
  d: string;
}

const NONCE_PATTERN = /^[0-9a-f]{16}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseEnvelope(body: unknown): IngestEnvelope {
  if (typeof body !== 'string') {
    throw new AppError('INVALID_JSON', 'Envelope body is not valid JSON text');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AppError('INVALID_JSON', 'Envelope body is not valid JSON');
  }

  if (!isPlainObject(parsed)) {
    throw new AppError('INVALID_ENVELOPE', 'Envelope must be an object');
  }

  const { p, t, n, s, d } = parsed;
  if (
    typeof p !== 'string' ||
    typeof t !== 'number' ||
    typeof n !== 'string' ||
    typeof s !== 'string' ||
    typeof d !== 'string' ||
    !NONCE_PATTERN.test(n) ||
    !SIGNATURE_PATTERN.test(s)
  ) {
    throw new AppError(
      'INVALID_ENVELOPE',
      'Envelope requires p, t, n, s and d with the expected types and formats',
    );
  }

  return { p, t, n, s, d };
}
