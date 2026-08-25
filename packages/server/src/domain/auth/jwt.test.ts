import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Bearer JWT authentication', () => {
  it('distinguishes missing or malformed tokens from expired tokens', async () => {
    const app = await buildApp();
    apps.push(app);
    await app.ready();

    const missing = await app.inject({ method: 'GET', url: '/api/auth/me' });
    const malformed = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer definitely-not-a-jwt' },
    });
    const expiredToken = app.jwt.sign(
      { username: 'expired-user', role: 'user' },
      { expiresIn: -1 },
    );
    const expired = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${expiredToken}` },
    });

    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect(malformed.statusCode).toBe(401);
    expect(malformed.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({ error: { code: 'TOKEN_EXPIRED' } });
  });

  it('uses token claims for /me and performs server-side no-op logout', async () => {
    const app = await buildApp();
    apps.push(app);
    await app.ready();
    const token = app.jwt.sign({ username: 'reader', role: 'user' });

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ user: { username: 'reader', role: 'user' } });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ success: true });
  });

  it('rate-limits the login route independently by IP', async () => {
    const app = await buildApp();
    apps.push(app);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const captcha = await app.inject({ method: 'GET', url: '/api/auth/captcha' });
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '192.0.2.10',
        payload: {
          username: 'nobody',
          password: 'wrong',
          captchaId: captcha.json().captchaId,
          captchaCode: 'WRONG',
        },
      });
      expect(rejected.statusCode).toBe(401);
      expect(rejected.json()).toMatchObject({ error: { code: 'INVALID_CAPTCHA' } });
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '192.0.2.10',
      payload: {},
    });
    const otherIp = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '192.0.2.11',
      payload: {},
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(otherIp.statusCode).toBe(400);
    expect(otherIp.json()).toMatchObject({ error: { code: 'INVALID_JSON' } });
  });
});
