import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '../stores/auth.js';
import { pinia } from '../stores/index.js';
import { login } from './auth.js';
import { downloadExport, requestJson, setSessionInvalidHandler } from './client.js';
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

  it('opens the save picker before fetch and streams an authenticated export to disk', async () => {
    useAuthStore(pinia).setSession('export-token', { username: 'reader', role: 'user' });
    const callOrder: string[] = [];
    const write = vi.fn();
    const writable = new WritableStream<Uint8Array>({ write });
    const createWritable = vi.fn().mockResolvedValue(writable);
    const showSaveFilePicker = vi.fn().mockImplementation(() => {
      callOrder.push('picker');
      return Promise.resolve({ createWritable } as unknown as FileSystemFileHandle);
    });
    vi.stubGlobal('window', { isSecureContext: true, showSaveFilePicker });

    const response = new Response('record_id\n123\n', {
      status: 200,
      headers: { 'content-type': 'text/csv' },
    });
    const fetchMock = vi.fn().mockImplementation(() => {
      callOrder.push('fetch');
      return Promise.resolve(response);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadExport('/api/export', {
        body: { range: { start: 1, end: 2 } },
        filename: 'collect_prj_example_20260829120000.csv',
      }),
    ).resolves.toEqual({
      status: 'success',
      filename: 'collect_prj_example_20260829120000.csv',
    });
    expect(callOrder).toEqual(['picker', 'fetch']);
    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: 'collect_prj_example_20260829120000.csv',
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer export-token');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(init?.body).toBe(JSON.stringify({ range: { start: 1, end: 2 } }));
    expect(createWritable).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalled();
  });

  it('returns silently without fetching when the user cancels the save picker', async () => {
    const showSaveFilePicker = vi
      .fn()
      .mockRejectedValue(new DOMException('The user aborted a request.', 'AbortError'));
    const fetchMock = vi.fn();
    vi.stubGlobal('window', { isSecureContext: true, showSaveFilePicker });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadExport('/api/export', { body: {}, filename: 'collect_cancelled.csv' }),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses a standard non-ok response without creating a writable file', async () => {
    const createWritable = vi.fn();
    const showSaveFilePicker = vi
      .fn()
      .mockResolvedValue({ createWritable } as unknown as FileSystemFileHandle);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: { code: 'RATE_LIMITED', message: 'export gate full' },
          requestId: 'req_export',
        },
        429,
      ),
    );
    vi.stubGlobal('window', { isSecureContext: true, showSaveFilePicker });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadExport('/api/export', { body: {}, filename: 'fallback.csv' }),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
      requestId: 'req_export',
      message: 'export gate full',
    });
    expect(showSaveFilePicker).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(createWritable).not.toHaveBeenCalled();
  });

  it('reads the truncation header before piping the response body', async () => {
    const callOrder: string[] = [];
    const response = new Response('record_id\n123\n', {
      status: 200,
      headers: { 'x-export-truncated': '1' },
    });
    const getHeader = response.headers.get.bind(response.headers);
    vi.spyOn(response.headers, 'get').mockImplementation((name) => {
      if (name.toLowerCase() === 'x-export-truncated') {
        callOrder.push('header');
      }
      return getHeader(name);
    });
    const createWritable = vi.fn().mockImplementation(() => {
      callOrder.push('writable');
      return Promise.resolve(new WritableStream<Uint8Array>());
    });
    vi.stubGlobal('window', {
      isSecureContext: true,
      showSaveFilePicker: vi
        .fn()
        .mockResolvedValue({ createWritable } as unknown as FileSystemFileHandle),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    await expect(
      downloadExport('/api/export', { body: {}, filename: 'collect_truncated.csv' }),
    ).resolves.toEqual({ status: 'truncated', filename: 'collect_truncated.csv' });
    expect(callOrder).toEqual(['header', 'writable']);
  });

  it.each([
    { isSecureContext: false, showSaveFilePicker: vi.fn() },
    { isSecureContext: true, showSaveFilePicker: undefined },
  ])('rejects unsupported or insecure browser contexts with a clear message', async (browser) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('window', browser);
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadExport('/api/export', { body: {}, filename: 'collect_unavailable.csv' }),
    ).rejects.toMatchObject({
      name: 'FileSystemExportUnavailableError',
      message: 'CSV 导出需要 Chrome 或 Edge，且需通过 HTTPS 或 localhost 访问。',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
