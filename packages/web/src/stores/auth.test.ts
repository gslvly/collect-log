import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pinia as apiPinia } from './index.js';
import { AUTH_TOKEN_STORAGE_KEY, useAuthStore } from './auth.js';

class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();

  get length(): number {
    return this.#items.size;
  }

  clear(): void {
    this.#items.clear();
  }

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
}

const sessionStorageMock = new MemoryStorage();
vi.stubGlobal('sessionStorage', sessionStorageMock);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('auth store', () => {
  beforeEach(() => {
    sessionStorageMock.clear();
    useAuthStore(apiPinia).$reset();
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('stores the login token in memory and sessionStorage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          token: 'jwt-token',
          expiresIn: 43_200,
          user: { username: 'admin', role: 'admin' },
        }),
      ),
    );
    const authStore = useAuthStore();

    await authStore.login({
      username: 'admin',
      password: 'secret',
      captchaId: 'captcha-id',
      captchaCode: '1234',
    });

    expect(authStore.token).toBe('jwt-token');
    expect(authStore.user).toEqual({ username: 'admin', role: 'admin' });
    expect(sessionStorageMock.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('jwt-token');
  });

  it('clears the local session when logging out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: true })));
    const authStore = useAuthStore();
    authStore.setSession('jwt-token', { username: 'admin', role: 'admin' });

    await authStore.logout();

    expect(authStore.token).toBeNull();
    expect(authStore.user).toBeNull();
    expect(sessionStorageMock.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('still clears the local session when the logout request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const authStore = useAuthStore();
    authStore.setSession('jwt-token', { username: 'admin', role: 'admin' });

    await expect(authStore.logout()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    expect(authStore.token).toBeNull();
    expect(authStore.user).toBeNull();
    expect(sessionStorageMock.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('restores a token from sessionStorage and validates it through /api/auth/me', async () => {
    sessionStorageMock.setItem(AUTH_TOKEN_STORAGE_KEY, 'restored-token');
    setActivePinia(createPinia());
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ user: { username: 'reader', role: 'user' } })),
    );
    const authStore = useAuthStore();

    expect(authStore.token).toBe('restored-token');
    expect(authStore.user).toBeNull();
    await authStore.restoreSession();

    expect(authStore.token).toBe('restored-token');
    expect(authStore.user).toEqual({ username: 'reader', role: 'user' });
    expect(authStore.isAuthenticated).toBe(true);
  });
});
