import { useAuthStore } from '../stores/auth.js';
import { pinia } from '../stores/index.js';
import { ApiError, isErrorCode, type ErrorCode, type ExpectedField } from './errors.js';

interface RequestJsonOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
  skipAuthFailureHandling?: boolean;
}

interface DownloadExportOptions {
  body: unknown;
  filename: string;
  headers?: HeadersInit;
  signal?: AbortSignal;
}

export type DownloadExportResult =
  { status: 'cancelled' } | { status: 'success' | 'truncated'; filename: string };

export const FILE_SYSTEM_EXPORT_UNAVAILABLE_MESSAGE =
  'CSV 导出需要 Chrome 或 Edge，且需通过 HTTPS 或 localhost 访问。';

export class FileSystemExportUnavailableError extends Error {
  constructor() {
    super(FILE_SYSTEM_EXPORT_UNAVAILABLE_MESSAGE);
    this.name = 'FileSystemExportUnavailableError';
  }
}

interface ServerErrorPayload {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    field?: string;
    expected?: ExpectedField;
    schemaVersion?: number;
  };
  requestId: string;
}

type SessionInvalidHandler = () => void;
let sessionInvalidHandler: SessionInvalidHandler | null = null;

export function setSessionInvalidHandler(handler: SessionInvalidHandler | null): void {
  sessionInvalidHandler = handler;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorCode(value: unknown): ErrorCode | undefined {
  return isErrorCode(value) ? value : undefined;
}

function isExpectedField(value: unknown): value is ExpectedField {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.label === 'string' &&
    typeof value.type === 'string' &&
    typeof value.required === 'boolean' &&
    (value.description === undefined || typeof value.description === 'string')
  );
}

function parseServerError(value: unknown): ServerErrorPayload | null {
  if (!isRecord(value) || value.success !== false || !isRecord(value.error)) {
    return null;
  }

  const code = getErrorCode(value.error.code);
  if (
    code === undefined ||
    typeof value.error.message !== 'string' ||
    typeof value.requestId !== 'string' ||
    (value.error.field !== undefined && typeof value.error.field !== 'string') ||
    (value.error.expected !== undefined && !isExpectedField(value.error.expected)) ||
    (value.error.schemaVersion !== undefined && typeof value.error.schemaVersion !== 'number')
  ) {
    return null;
  }

  return {
    success: false,
    error: {
      code,
      message: value.error.message,
      ...(value.error.field === undefined ? {} : { field: value.error.field }),
      ...(value.error.expected === undefined ? {} : { expected: value.error.expected }),
      ...(value.error.schemaVersion === undefined
        ? {}
        : { schemaVersion: value.error.schemaVersion }),
    },
    requestId: value.requestId,
  };
}

function networkError(httpStatus: number, message = 'Network request failed'): ApiError {
  return new ApiError(message, { code: 'NETWORK_ERROR', httpStatus });
}

function handleSessionInvalid(code: string, skip: boolean): void {
  if (skip || (code !== 'TOKEN_EXPIRED' && code !== 'UNAUTHORIZED')) {
    return;
  }
  useAuthStore(pinia).clearSession();
  sessionInvalidHandler?.();
}

function toApiError(
  serverError: ServerErrorPayload,
  httpStatus: number,
  skipAuthFailureHandling: boolean,
): ApiError {
  handleSessionInvalid(serverError.error.code, skipAuthFailureHandling);
  return new ApiError(serverError.error.message, {
    code: serverError.error.code,
    httpStatus,
    requestId: serverError.requestId,
    ...(serverError.error.field === undefined ? {} : { field: serverError.error.field }),
    ...(serverError.error.expected === undefined ? {} : { expected: serverError.error.expected }),
    ...(serverError.error.schemaVersion === undefined
      ? {}
      : { schemaVersion: serverError.error.schemaVersion }),
  });
}

function authenticatedHeaders(headersInit?: HeadersInit): Headers {
  const authStore = useAuthStore(pinia);
  const headers = new Headers(headersInit);
  if (authStore.token !== null) {
    headers.set('Authorization', `Bearer ${authStore.token}`);
  }
  return headers;
}

export async function requestJson<T>(path: string, options: RequestJsonOptions = {}): Promise<T> {
  const headers = authenticatedHeaders(options.headers);
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    throw networkError(0);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw networkError(response.status, 'Server returned a non-JSON response');
  }

  const serverError = parseServerError(payload);
  if (serverError !== null) {
    throw toApiError(serverError, response.status, options.skipAuthFailureHandling === true);
  }

  if (!response.ok || !isRecord(payload)) {
    throw networkError(response.status, 'Server returned an unexpected response');
  }

  return payload as T;
}

export async function downloadExport(
  path: string,
  options: DownloadExportOptions,
): Promise<DownloadExportResult> {
  if (typeof window.showSaveFilePicker !== 'function' || window.isSecureContext === false) {
    throw new FileSystemExportUnavailableError();
  }

  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await window.showSaveFilePicker({ suggestedName: options.filename });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { status: 'cancelled' };
    }
    throw error;
  }

  const headers = authenticatedHeaders(options.headers);
  headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    throw networkError(0);
  }

  if (!response.ok) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw networkError(response.status, 'Server returned a non-JSON response');
    }
    const serverError = parseServerError(payload);
    if (serverError !== null) {
      throw toApiError(serverError, response.status, false);
    }
    throw networkError(response.status, 'Server returned an unexpected response');
  }

  const truncated = response.headers.get('x-export-truncated') === '1';
  if (response.body === null) {
    throw networkError(response.status, 'Server returned an empty export response');
  }

  try {
    const writable = await fileHandle.createWritable();
    await response.body.pipeTo(writable);
  } catch {
    throw networkError(response.status, 'Failed to write the export file');
  }

  return {
    status: truncated ? 'truncated' : 'success',
    filename: options.filename,
  };
}
