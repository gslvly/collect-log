export const ERROR_CODES = [
  'INVALID_JSON',
  'INVALID_ENVELOPE',
  'INVALID_TABLE_ID',
  'INVALID_RECORD_ID',
  'INVALID_OCCURRED_AT',
  'UNKNOWN_FIELD',
  'DEPRECATED_FIELD',
  'REQUIRED_FIELD_MISSING',
  'INVALID_FIELD_TYPE',
  'FIELD_VALUE_TOO_LONG',
  'TOO_MANY_FIELDS',
  'INVALID_QUERY',
  'CONFIRMATION_REQUIRED',
  'INVALID_SIGNATURE',
  'SIGNATURE_EXPIRED',
  'REPLAYED_NONCE',
  'UNAUTHORIZED',
  'TOKEN_EXPIRED',
  'INVALID_CREDENTIALS',
  'INVALID_CAPTCHA',
  'FORBIDDEN',
  'TABLE_DISABLED',
  'TABLE_NOT_FOUND',
  'FIELD_NOT_FOUND',
  'USER_NOT_FOUND',
  'ROUTE_NOT_FOUND',
  'USERNAME_EXISTS',
  'FIELD_KEY_EXISTS',
  'FIELD_KEY_RETIRED',
  'TABLE_STATE_CONFLICT',
  'LAST_SUPER_ADMIN',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'INSERT_FAILED',
  'TABLE_NOT_READY',
  'CLICKHOUSE_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_JSON: 400,
  INVALID_ENVELOPE: 400,
  INVALID_TABLE_ID: 400,
  INVALID_RECORD_ID: 400,
  INVALID_OCCURRED_AT: 400,
  UNKNOWN_FIELD: 400,
  DEPRECATED_FIELD: 400,
  REQUIRED_FIELD_MISSING: 400,
  INVALID_FIELD_TYPE: 400,
  FIELD_VALUE_TOO_LONG: 400,
  TOO_MANY_FIELDS: 400,
  INVALID_QUERY: 400,
  CONFIRMATION_REQUIRED: 400,
  INVALID_SIGNATURE: 401,
  SIGNATURE_EXPIRED: 401,
  REPLAYED_NONCE: 401,
  UNAUTHORIZED: 401,
  TOKEN_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  INVALID_CAPTCHA: 401,
  FORBIDDEN: 403,
  TABLE_DISABLED: 403,
  TABLE_NOT_FOUND: 404,
  FIELD_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,
  USERNAME_EXISTS: 409,
  FIELD_KEY_EXISTS: 409,
  FIELD_KEY_RETIRED: 409,
  TABLE_STATE_CONFLICT: 409,
  LAST_SUPER_ADMIN: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  INSERT_FAILED: 500,
  TABLE_NOT_READY: 503,
  CLICKHOUSE_UNAVAILABLE: 503,
};

export interface ExpectedField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface AppErrorDetails {
  field?: string;
  expected?: ExpectedField;
  schemaVersion?: number;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly field: string | undefined;
  readonly expected: ExpectedField | undefined;
  readonly schemaVersion: number | undefined;

  constructor(code: ErrorCode, message: string, details: AppErrorDetails = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.field = details.field;
    this.expected = details.expected;
    this.schemaVersion = details.schemaVersion;
  }
}

export interface ErrorResponse {
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

export function serializeError(error: AppError, requestId: string): ErrorResponse {
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.field === undefined ? {} : { field: error.field }),
      ...(error.expected === undefined ? {} : { expected: error.expected }),
      ...(error.schemaVersion === undefined ? {} : { schemaVersion: error.schemaVersion }),
    },
    requestId,
  };
}
