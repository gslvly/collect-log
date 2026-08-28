import { describe, expect, it } from 'vitest';

import type { IngestEnvelope } from './envelope.js';
import { signatureFor, verifyEnvelopeSignature } from './signature.js';

const unsignedEnvelope = {
  p: 'prj_01KABCDEF0123456789ABCDEFG',
  t: 1_756_012_830_123,
  n: 'a3f9c2d1b7e40851',
  d: '{"occurredAt":1756012830123,"data":{"result":"success"}}',
};

function envelope(secret: string): IngestEnvelope {
  return { ...unsignedEnvelope, s: signatureFor(secret, unsignedEnvelope) };
}

describe('ingest HMAC signatures', () => {
  it('constructs the exact newline-delimited HMAC-SHA256 signature', () => {
    expect(signatureFor('stage-c-secret', unsignedEnvelope)).toBe(
      '813b4e490bcdb0b2cd49f3c9ef972cd2b7101989ab929018f7bb7367bd393b9a',
    );
  });

  it('uses timing-safe comparison for the current secret', () => {
    const signed = envelope('current-secret');
    expect(
      verifyEnvelopeSignature(
        signed,
        {
          ingestSecret: 'current-secret',
          ingestSecretPrev: '',
          ingestSecretPrevExpiresAt: null,
        },
        unsignedEnvelope.t,
      ),
    ).toBe(true);
    expect(
      verifyEnvelopeSignature(
        { ...signed, s: '0'.repeat(64) },
        {
          ingestSecret: 'current-secret',
          ingestSecretPrev: '',
          ingestSecretPrevExpiresAt: null,
        },
        unsignedEnvelope.t,
      ),
    ).toBe(false);
  });

  it('accepts the previous secret only before its expiry', () => {
    const signed = envelope('previous-secret');
    const secrets = {
      ingestSecret: 'current-secret',
      ingestSecretPrev: 'previous-secret',
      ingestSecretPrevExpiresAt: new Date(unsignedEnvelope.t + 1).toISOString(),
    };

    expect(verifyEnvelopeSignature(signed, secrets, unsignedEnvelope.t)).toBe(true);
    expect(verifyEnvelopeSignature(signed, secrets, unsignedEnvelope.t + 1)).toBe(false);
  });
});
