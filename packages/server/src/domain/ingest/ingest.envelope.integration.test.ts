import { randomUUID } from 'node:crypto';

import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';

import { configuredLimits } from '../../config/limits.js';
import { app, overwriteStatus, post, signedRequest } from './ingest.integration.fixtures.js';

describe('stage C ingest route', () => {
  it.each([
    ['too early', () => Date.now() - configuredLimits.ingest.occurredAtPastMs - 1],
    ['too late', () => Date.now() + configuredLimits.ingest.occurredAtFutureMs + 1_000],
  ] as const)('rejects occurredAt that is %s', async (_label, occurredAt) => {
    const response = await post(
      signedRequest({
        recordId: randomUUID(),
        occurredAt: occurredAt(),
        data: { event_name: 'x' },
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_OCCURRED_AT' } });
  });

  it.each([
    ['disabled', 'TABLE_DISABLED', 403],
    ['archived', 'TABLE_DISABLED', 403],
    ['creating', 'TABLE_NOT_READY', 503],
    ['failed', 'TABLE_NOT_READY', 503],
  ] as const)('maps the %s table state to %s', async (status, code, httpStatus) => {
    overwriteStatus(status);
    try {
      const response = await post(
        signedRequest({
          recordId: randomUUID(),
          occurredAt: Date.now(),
          data: { event_name: 'x' },
        }),
      );

      expect(response.statusCode).toBe(httpStatus);
      expect(response.json()).toMatchObject({ error: { code } });
    } finally {
      overwriteStatus('active');
    }
  });

  it('rejects a non-UUID recordId', async () => {
    const response = await post(
      signedRequest({
        recordId: 'not-a-uuid',
        occurredAt: Date.now(),
        data: { event_name: 'x' },
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_RECORD_ID' } });
  });

  it('rejects an origin outside the ingest whitelist', async () => {
    const response = await post(
      signedRequest({
        recordId: randomUUID(),
        occurredAt: Date.now(),
        data: { event_name: 'x' },
      }),
      'https://forbidden.example.test',
    );

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(response.headers).not.toHaveProperty('access-control-allow-origin');
  });

  it('rejects an envelope project that differs from the URL project', async () => {
    const response = await post(
      signedRequest(
        {
          recordId: randomUUID(),
          occurredAt: Date.now(),
          data: { event_name: 'x' },
        },
        { p: `prj_${ulid()}` },
      ),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_ENVELOPE' } });
  });

  it('validates the URL project before parsing the envelope body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/ingest/v1/projects/not-a-project/rows',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      payload: '{',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_PROJECT_ID' } });
  });
});
