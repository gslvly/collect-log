import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { bootstrapSchema } from '../../bootstrap/schema.js';
import { CaptchaService } from '../auth/captcha.js';
import { metaClient } from '../../infra/clickhouse.js';
import { serial } from '../../infra/serial.js';
import { userRepository } from './repository.js';
import type { UserRole } from './types.js';

const CAPTCHA_CODE = 'ABCDE';
const namespace = `stage2_${randomUUID().replaceAll('-', '')}_`;
const apps: FastifyInstance[] = [];

function username(label: string): string {
  return `${namespace}${label}`;
}

async function makeApp(): Promise<FastifyInstance> {
  const app = await buildApp({
    captchaService: new CaptchaService(120, () => CAPTCHA_CODE),
  });
  apps.push(app);
  return app;
}

async function createFixtureUser(
  label: string,
  role: UserRole,
  password = 'initial-password',
): Promise<string> {
  const name = username(label);
  await userRepository.create({ username: name, password, role });
  return name;
}

async function getCaptchaId(app: FastifyInstance): Promise<string> {
  const response = await app.inject({ method: 'GET', url: '/api/auth/captcha' });
  expect(response.statusCode).toBe(200);
  expect(response.json().image).toMatch(/^data:image\/svg\+xml;base64,/);
  return response.json().captchaId as string;
}

async function login(app: FastifyInstance, name: string, password: string): Promise<string> {
  const captchaId = await getCaptchaId(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      username: name,
      password,
      captchaId,
      captchaCode: CAPTCHA_CODE,
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json().token as string;
}

function authorization(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function cleanupUsers(): Promise<void> {
  await serial(async () => {
    await metaClient.command({
      query: 'DELETE FROM meta.app_users WHERE startsWith(username, {prefix:String})',
      query_params: { prefix: namespace },
      clickhouse_settings: { mutations_sync: '2' },
    });
  });
}

beforeAll(async () => {
  await bootstrapSchema();
  await cleanupUsers();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await cleanupUsers();
});

describe('DESIGN 17.4 account acceptance against ClickHouse', () => {
  it('bootstraps exactly one initial super_admin and stores only its Argon2id hash', async () => {
    const first = await userRepository.bootstrapSuperAdmin(username('bootstrap'), 'plain-password');
    const second = await userRepository.bootstrapSuperAdmin(
      username('ignored-bootstrap'),
      'ignored-password',
    );
    const stored = await userRepository.findActiveByUsername(username('bootstrap'));

    expect(first).toBe('created');
    expect(second).toBe('already_exists');
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(stored?.passwordHash).not.toContain('plain-password');
  });

  it('allows super_admin to create and delete admin and user accounts', async () => {
    const app = await makeApp();
    const root = await createFixtureUser('root', 'super_admin');
    const token = await login(app, root, 'initial-password');

    for (const role of ['admin', 'user'] as const) {
      const target = username(role);
      const created = await app.inject({
        method: 'POST',
        url: '/api/admin/users',
        headers: authorization(token),
        payload: { username: target, password: 'target-password', role },
      });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({ user: { username: target, role, status: 'active' } });

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/admin/users/${encodeURIComponent(target)}`,
        headers: authorization(token),
      });
      expect(deleted.statusCode).toBe(200);
      await expect(userRepository.findByUsername(target)).resolves.toBeNull();
    }
  });

  it('allows admin to manage users but forbids creating or deleting peer admins', async () => {
    const app = await makeApp();
    const admin = await createFixtureUser('admin', 'admin');
    const peer = await createFixtureUser('peer', 'admin');
    const token = await login(app, admin, 'initial-password');
    const managedUser = username('managed-user');

    const createUser = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: authorization(token),
      payload: { username: managedUser, password: 'user-password', role: 'user' },
    });
    const createAdmin = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: authorization(token),
      payload: { username: username('forbidden-admin'), password: 'password', role: 'admin' },
    });
    const deletePeer = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${encodeURIComponent(peer)}`,
      headers: authorization(token),
    });
    const deleteUser = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${encodeURIComponent(managedUser)}`,
      headers: authorization(token),
    });

    expect(createUser.statusCode).toBe(200);
    expect(createAdmin.statusCode).toBe(403);
    expect(createAdmin.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(deletePeer.statusCode).toBe(403);
    expect(deletePeer.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(deleteUser.statusCode).toBe(200);
  });

  it('rejects super_admin deletion for every role', async () => {
    const app = await makeApp();
    const root = await createFixtureUser('root', 'super_admin');
    const admin = await createFixtureUser('admin', 'admin');
    const user = await createFixtureUser('user', 'user');

    for (const actor of [root, admin, user]) {
      const token = await login(app, actor, 'initial-password');
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/admin/users/${encodeURIComponent(root)}`,
        headers: authorization(token),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
  });

  it('rejects disabling the last active super_admin', async () => {
    const app = await makeApp();
    const root = await createFixtureUser('root', 'super_admin');
    const token = await login(app, root, 'initial-password');

    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${encodeURIComponent(root)}/status`,
      headers: authorization(token),
      payload: { status: 'disabled' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'LAST_SUPER_ADMIN' } });
  });

  it('consumes a captcha after the first validation attempt', async () => {
    const app = await makeApp();
    const root = await createFixtureUser('root', 'super_admin');
    const captchaId = await getCaptchaId(app);
    const payload = {
      username: root,
      password: 'initial-password',
      captchaId,
      captchaCode: CAPTCHA_CODE,
    };

    const first = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
    const second = await app.inject({ method: 'POST', url: '/api/auth/login', payload });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(401);
    expect(second.json()).toMatchObject({ error: { code: 'INVALID_CAPTCHA' } });
  });

  it('allows every role to change its own password', async () => {
    const app = await makeApp();

    for (const role of ['super_admin', 'admin', 'user'] as const) {
      const account = await createFixtureUser(role, role);
      const token = await login(app, account, 'initial-password');
      const changed = await app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: authorization(token),
        payload: { currentPassword: 'initial-password', newPassword: 'updated-password' },
      });

      expect(changed.statusCode).toBe(200);
      await expect(login(app, account, 'updated-password')).resolves.toEqual(expect.any(String));
    }
  });
});

describe('DESIGN 17.5 account concurrency against ClickHouse', () => {
  it('allows exactly one of two concurrent duplicate username creations', async () => {
    const app = await makeApp();
    const root = await createFixtureUser('root', 'super_admin');
    const token = await login(app, root, 'initial-password');
    const duplicate = username('duplicate');
    const request = () =>
      app.inject({
        method: 'POST',
        url: '/api/admin/users',
        headers: authorization(token),
        payload: { username: duplicate, password: 'duplicate-password', role: 'user' },
      });

    const responses = await Promise.all([request(), request()]);
    const statusCodes = responses.map((response) => response.statusCode).sort();
    const failure = responses.find((response) => response.statusCode === 409);

    expect(statusCodes).toEqual([200, 409]);
    expect(failure?.json()).toMatchObject({ error: { code: 'USERNAME_EXISTS' } });
  });
});
