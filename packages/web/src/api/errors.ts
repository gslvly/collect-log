export const ERROR_CODES = [
  'INVALID_JSON',
  'INVALID_ENVELOPE',
  'INVALID_PROJECT_ID',
  'INVALID_RECORD_ID',
  'INVALID_OCCURRED_AT',
  'INVALID_FIELD_KEY',
  'UNKNOWN_FIELD',
  'DEPRECATED_FIELD',
  'REQUIRED_FIELD_MISSING',
  'INVALID_FIELD_TYPE',
  'INVALID_FIELD_VALUE',
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

export const LOCAL_ERROR_CODES = ['NETWORK_ERROR'] as const;
export type LocalErrorCode = (typeof LOCAL_ERROR_CODES)[number];
export type ApiErrorCode = ErrorCode | LocalErrorCode;

export interface ExpectedField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface ApiErrorDetails {
  code: ApiErrorCode;
  httpStatus: number;
  requestId?: string;
  field?: string;
  expected?: ExpectedField;
  schemaVersion?: number;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly httpStatus: number;
  readonly requestId: string | undefined;
  readonly field: string | undefined;
  readonly expected: ExpectedField | undefined;
  readonly schemaVersion: number | undefined;

  constructor(message: string, details: ApiErrorDetails) {
    super(message);
    this.name = 'ApiError';
    this.code = details.code;
    this.httpStatus = details.httpStatus;
    this.requestId = details.requestId;
    this.field = details.field;
    this.expected = details.expected;
    this.schemaVersion = details.schemaVersion;
  }
}

export const ERROR_MESSAGES = {
  INVALID_JSON: '请求内容格式不正确',
  INVALID_ENVELOPE: '上报信封格式不正确',
  INVALID_PROJECT_ID: '项目 ID 格式不正确',
  INVALID_RECORD_ID: '记录 ID 格式不正确',
  INVALID_OCCURRED_AT: '事件发生时间不正确',
  INVALID_FIELD_KEY: '字段 Key 格式不正确',
  UNKNOWN_FIELD: '包含未知字段',
  DEPRECATED_FIELD: '包含已废弃字段',
  REQUIRED_FIELD_MISSING: '缺少必填字段',
  INVALID_FIELD_TYPE: '字段类型不正确',
  INVALID_FIELD_VALUE: '字段值不符合要求',
  FIELD_VALUE_TOO_LONG: '字段内容过长',
  TOO_MANY_FIELDS: '字段数量超过限制',
  INVALID_QUERY: '查询条件不正确',
  CONFIRMATION_REQUIRED: '请输入正确的确认内容',
  INVALID_SIGNATURE: '上报签名无效',
  SIGNATURE_EXPIRED: '上报签名已过期',
  REPLAYED_NONCE: '检测到重复的上报请求',
  UNAUTHORIZED: '登录状态无效，请重新登录',
  TOKEN_EXPIRED: '登录已过期，请重新登录',
  INVALID_CREDENTIALS: '用户名或密码错误',
  INVALID_CAPTCHA: '验证码错误或已过期',
  FORBIDDEN: '没有权限执行此操作',
  TABLE_DISABLED: '数据采集表当前不可上报',
  TABLE_NOT_FOUND: '数据采集表不存在',
  FIELD_NOT_FOUND: '字段不存在',
  USER_NOT_FOUND: '账户不存在',
  ROUTE_NOT_FOUND: '请求的接口不存在',
  USERNAME_EXISTS: '用户名已存在',
  FIELD_KEY_EXISTS: '字段 Key 正被使用中的字段占用',
  FIELD_KEY_RETIRED: '字段 Key 已被软废弃字段占用，需先物理删除该列才能复用',
  TABLE_STATE_CONFLICT: '数据采集表状态不允许此操作',
  LAST_SUPER_ADMIN: '不能停用最后一个超级管理员',
  PAYLOAD_TOO_LARGE: '请求内容超过大小限制',
  UNSUPPORTED_MEDIA_TYPE: '不支持该请求内容类型',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  INTERNAL_ERROR: '服务暂时不可用，请稍后重试',
  INSERT_FAILED: '数据写入失败',
  TABLE_NOT_READY: '数据采集表尚未就绪',
  CLICKHOUSE_UNAVAILABLE: '数据服务暂时不可用',
} as const satisfies Record<ErrorCode, string>;

export const LOCAL_ERROR_MESSAGES = {
  NETWORK_ERROR: '网络请求失败，请检查连接后重试',
} as const satisfies Record<LocalErrorCode, string>;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export function getApiErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return LOCAL_ERROR_MESSAGES.NETWORK_ERROR;
  }
  if (error.code === 'NETWORK_ERROR') {
    return LOCAL_ERROR_MESSAGES.NETWORK_ERROR;
  }
  return ERROR_MESSAGES[error.code];
}
