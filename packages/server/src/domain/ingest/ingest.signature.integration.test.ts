import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { configuredLimits } from '../../config/limits.js';
import {
  ingestSecret,
  overwriteSecrets,
  post,
  restartApp,
  schemaVersion,
  signedRequest,
  storedRows,
} from './ingest.integration.fixtures.js';

describe('stage C ingest route', () => {
  it('writes a signed cross-origin row with complete columns and rejects its replay', async () => {
    const occurredAt = Date.now();
    const registeredAt = new Date('2020-01-02T03:04:05.678Z').getTime();
    const request = signedRequest({
      occurredAt,
      data: {
        event_name: 'login',
        channel: 'sms',
        is_success: true,
        retry_count: 3,
        score: 0,
        registered_at: registeredAt,
      },
    });
    const accepted = await post(request, 'https://ingest.example.test');

    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.headers['access-control-allow-origin']).toBe('https://ingest.example.test');
    expect(accepted.json()).toEqual({
      success: true,
      recordId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      requestId: accepted.headers['x-request-id'],
    });

    const recordId = accepted.json().recordId as string;
    const rows = await storedRows(recordId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      record_id: recordId,
      schema_version: schemaVersion,
      occurred_at: String(occurredAt),
      event_name: 'login',
      channel: 'sms',
      is_success: true,
      note: null,
      retry_count: 3,
      score: 0,
      registered_at: String(registeredAt),
    });
    expect(rows[0]?.received_at).not.toBe('');

    const replayed = await post(request);
    expect(replayed.statusCode).toBe(401);
    expect(replayed.json()).toMatchObject({ error: { code: 'REPLAYED_NONCE' } });
  });

  it('distinguishes invalid and expired signatures', async () => {
    const payload = { recordId: randomUUID(), occurredAt: Date.now(), data: { event_name: 'x' } };
    const invalid = await post(signedRequest(payload, { signature: '0'.repeat(64) }));
    const expired = await post(
      signedRequest(payload, {
        t: Date.now() - configuredLimits.ingest.signatureWindowMs - 1,
      }),
    );

    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toMatchObject({ error: { code: 'INVALID_SIGNATURE' } });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({ error: { code: 'SIGNATURE_EXPIRED' } });
  });

  it('accepts the previous secret in its grace period and rejects the same envelope after expiry', async () => {
    const request = signedRequest(
      { recordId: randomUUID(), occurredAt: Date.now(), data: { event_name: 'rotation' } },
      { secret: ingestSecret },
    );
    overwriteSecrets(
      'rotated-current-secret',
      ingestSecret,
      new Date(Date.now() + 60_000).toISOString(),
    );

    const accepted = await post(request);
    expect(accepted.statusCode, accepted.body).toBe(200);

    overwriteSecrets(
      'rotated-current-secret',
      ingestSecret,
      new Date(Date.now() - 1).toISOString(),
    );
    await restartApp();

    const rejected = await post(request);
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toMatchObject({ error: { code: 'INVALID_SIGNATURE' } });

    overwriteSecrets(ingestSecret, '', null);
  });
});
