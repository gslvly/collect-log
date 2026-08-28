import { createHmac, timingSafeEqual } from 'node:crypto';

import type { IngestEnvelope } from './envelope.js';

export interface IngestSecrets {
  ingestSecret: string;
  ingestSecretPrev: string;
  ingestSecretPrevExpiresAt: string | null;
}

export function signatureFor(
  secret: string,
  { p, t, n, d }: Pick<IngestEnvelope, 'p' | 't' | 'n' | 'd'>,
): string {
  const signBase = p + '\n' + t + '\n' + n + '\n' + d;
  return createHmac('sha256', secret).update(signBase).digest('hex');
}

function signaturesMatch(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(actual) || !/^[0-9a-f]{64}$/.test(expected)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

export function verifyEnvelopeSignature(
  envelope: IngestEnvelope,
  secrets: IngestSecrets,
  now: number,
): boolean {
  if (signaturesMatch(envelope.s, signatureFor(secrets.ingestSecret, envelope))) {
    return true;
  }

  const previousExpiresAt =
    secrets.ingestSecretPrevExpiresAt === null
      ? Number.NaN
      : Date.parse(secrets.ingestSecretPrevExpiresAt);
  if (
    secrets.ingestSecretPrev === '' ||
    !Number.isFinite(previousExpiresAt) ||
    previousExpiresAt <= now
  ) {
    return false;
  }

  return signaturesMatch(envelope.s, signatureFor(secrets.ingestSecretPrev, envelope));
}
