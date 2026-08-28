import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '../stores/auth.js';
import { pinia } from '../stores/index.js';
import { login } from './auth.js';
import { requestJson, setSessionInvalidHandler } from './client.js';
import { ApiError } from './errors.js';

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
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('API client', () => {
  beforeEach(() => {
    sessionStorageMock.clear();
    useAuthStore(pinia).$reset();
    setSessionInvalidHandler(null);
    vi.restoreAllMocks();
  });

  it('parses a successful JSON response and injects the auth token', async () => {
    useAuthStore(pinia).setSession('test-token', { username: 'root', role: 'super_admin' });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ value: 42 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestJson<{ value: number }>('/api/example')).resolves.toEqual({ value: 42 });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
  });

  it('maps a server error body to ApiError including field metadata and requestId', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            success: false,
            error: {
              code: 'INVALID_FIELD_TYPE',
              message: 'wrong type',
              field: 'enabled',
              expected: { key: 'enabled', label: '启用', type: 'boolean', required: true },
              schemaVersion: 7,
            },
            requestId: 'req_123',
          },
          400,
        ),
      ),
    );

    const error = await requestJson('/api/example').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: 'INVALID_FIELD_TYPE',
      message: 'wrong type',
      httpStatus: 400,
      requestId: 'req_123',
      field: 'enabled',
      expected: { key: 'enabled', label: '启用', type: 'boolean', required: true },
      schemaVersion: 7,
    });
  });

  it.each([
    new Response('<html>bad gateway</html>', { status: 502 }),
    jsonResponse({ message: 'unexpected' }, 500),
  ])('normalizes non-JSON and malformed responses to NETWORK_ERROR', async (response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    await expect(requestJson('/api/example')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      httpStatus: response.status,
    });
  });

  it('normalizes a rejected fetch to NETWORK_ERROR with status 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));

    await expect(requestJson('/api/example')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      httpStatus: 0,
    });
  });

  it.each(['TOKEN_EXPIRED', 'UNAUTHORIZED'] as const)(
    'clears the local session and invokes the redirect handler for %s',
    async (code) => {
      const authStore = useAuthStore(pinia);
      authStore.setSession('expired-token', { username: 'reader', role: 'user' });
      const redirect = vi.fn();
      setSessionInvalidHandler(redirect);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse(
            {
              success: false,
              error: { code, message: 'invalid session' },
              requestId: 'req_auth',
            },
            401,
          ),
        ),
      );

      await expect(requestJson('/api/auth/me')).rejects.toMatchObject({ code });
      expect(authStore.token).toBeNull();
      expect(authStore.user).toBeNull();
      expect(redirect).toHaveBeenCalledOnce();
    },
  );

  it('does not clear or redirect on a 401 returned by the login endpoint', async () => {
    const authStore = useAuthStore(pinia);
    authStore.setSession('existing-token', { username: 'root', role: 'super_admin' });
    const redirect = vi.fn();
    setSessionInvalidHandler(redirect);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            success: false,
            error: { code: 'UNAUTHORIZED', message: 'not accepted' },
            requestId: 'req_login',
          },
          401,
        ),
      ),
    );

    await expect(
      login({ username: 'root', password: 'bad', captchaId: 'cap', captchaCode: '0000' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(authStore.token).toBe('existing-token');
    expect(redirect).not.toHaveBeenCalled();
  });
});
