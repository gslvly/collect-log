import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { configuredLimits } from './config/limits.js';
import { pingClickHouse } from './infra/clickhouse.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Fastify application foundation', () => {
  it('keeps text/plain bodies raw and maps oversized bodies to PAYLOAD_TOO_LARGE', async () => {
    const app = await buildApp();
    apps.push(app);
    app.post('/api/ingest/test-parser', async (request) => ({ body: request.body }));

    const body = '{"still":"a string"}';
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/ingest/test-parser',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      payload: body,
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ body });
    expect(accepted.headers['x-request-id']).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);

    const oversized = await app.inject({
      method: 'POST',
      url: '/api/ingest/test-parser',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      payload: 'x'.repeat(configuredLimits.ingest.maxBodyBytes + 1),
    });

    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({
      success: false,
      error: { code: 'PAYLOAD_TOO_LARGE' },
      requestId: oversized.headers['x-request-id'],
    });
  });

  it('uses separate ingest and console CORS origin lists', async () => {
    const app = await buildApp();
    apps.push(app);
    app.post('/api/ingest/test-cors', async () => ({ ok: true }));
    app.post('/api/test-cors', async () => ({ ok: true }));

    const ingest = await app.inject({
      method: 'OPTIONS',
      url: '/api/ingest/test-cors',
      headers: {
        origin: 'https://ingest.example.test',
        'access-control-request-method': 'POST',
      },
    });
    const consoleApi = await app.inject({
      method: 'OPTIONS',
      url: '/api/test-cors',
      headers: {
        origin: 'https://console.example.test',
        'access-control-request-method': 'POST',
      },
    });
    const wrongOrigin = await app.inject({
      method: 'OPTIONS',
      url: '/api/ingest/test-cors',
      headers: {
        origin: 'https://console.example.test',
        'access-control-request-method': 'POST',
      },
    });

    expect(ingest.headers['access-control-allow-origin']).toBe('https://ingest.example.test');
    expect(consoleApi.headers['access-control-allow-origin']).toBe('https://console.example.test');
    expect(wrongOrigin.headers).not.toHaveProperty('access-control-allow-origin');
  });

  it('keeps Fastify built-in client errors as 4xx instead of degrading them to 500', async () => {
    const app = await buildApp();
    apps.push(app);
    app.delete('/api/test-client-errors', async () => ({ ok: true }));
    app.post('/api/test-client-errors', async (request) => ({ body: request.body }));

    // axios 对没有 body 的 DELETE 依然会带上 application/json。
    const emptyBody = await app.inject({
      method: 'DELETE',
      url: '/api/test-client-errors',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    const unsupportedMediaType = await app.inject({
      method: 'POST',
      url: '/api/test-client-errors',
      headers: { 'content-type': 'application/xml' },
      payload: '<request/>',
    });
    const brokenJson = await app.inject({
      method: 'POST',
      url: '/api/test-client-errors',
      headers: { 'content-type': 'application/json' },
      payload: '{"unterminated":',
    });

    expect(emptyBody.statusCode).toBe(200);
    expect(unsupportedMediaType.statusCode).toBe(415);
    expect(unsupportedMediaType.json()).toMatchObject({
      success: false,
      error: { code: 'UNSUPPORTED_MEDIA_TYPE' },
      requestId: unsupportedMediaType.headers['x-request-id'],
    });
    expect(brokenJson.statusCode).toBe(400);
    expect(brokenJson.json()).toMatchObject({
      success: false,
      error: { code: 'INVALID_JSON' },
    });
  });

  it('returns the unified ROUTE_NOT_FOUND response for unmatched routes', async () => {
    const app = await buildApp();
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      success: false,
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'Route GET /does-not-exist was not found',
      },
      requestId: response.headers['x-request-id'],
    });
  });

  it('returns degraded promptly when the independent ClickHouse probe times out', async () => {
    const app = await buildApp({
      pingClickHouse: () =>
        pingClickHouse(
          (abortSignal) =>
            new Promise<void>((_resolve, reject) => {
              abortSignal.addEventListener('abort', () => reject(abortSignal.reason), {
                once: true,
              });
            }),
          10,
        ),
    });
    apps.push(app);

    const startedAt = Date.now();
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'degraded', clickhouse: 'error' });
  });
});
