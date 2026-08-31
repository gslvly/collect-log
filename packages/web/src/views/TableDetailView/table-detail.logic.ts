import {
  type CollectionField,
  type CreateFieldInput,
  type FieldOptionInput,
  type FieldStatus,
  type FieldType,
  type RetypeFieldInput,
  type TableStatus,
  type UpdateFieldInput,
} from '../../api/tables.js';
import type { DetailQueryInput, StatisticsInput, StatisticsRow } from '../../api/query.js';
import {
  canRegisterEnumValue,
  cloneEnumOptions,
  validateEnumOptions,
} from '../../enum-options.logic.js';
import type { Role } from '../../permissions.js';
import { FIELD_KEY_PATTERN } from '../TablesView/tables.logic.js';

export interface TableStatusAction {
  target: TableStatus;
  label: string;
  requiresConfirmation: boolean;
}

const TABLE_STATUS_ACTIONS = {
  creating: [],
  active: [
    { target: 'disabled', label: '停用', requiresConfirmation: true },
    { target: 'archived', label: '归档', requiresConfirmation: true },
  ],
  disabled: [
    { target: 'active', label: '启用', requiresConfirmation: false },
    { target: 'archived', label: '归档', requiresConfirmation: true },
  ],
  archived: [{ target: 'active', label: '重新启用', requiresConfirmation: false }],
  failed: [{ target: 'archived', label: '归档', requiresConfirmation: true }],
} as const satisfies Record<TableStatus, readonly TableStatusAction[]>;

export interface AddFieldFormValue {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  description: string;
  options: FieldOptionInput[];
}

export interface EditFieldFormValue {
  label: string;
  required: boolean;
  description: string;
}

export interface FieldFormValidation {
  valid: boolean;
  key?: string;
  label?: string;
  options?: string;
  form?: string;
}

export type FieldsByStatus = Record<FieldStatus, CollectionField[]>;

export const FIELD_STATUS_LABELS = {
  active: '使用中',
  deprecated: '已软废弃',
  dropped: '已物理删除',
  renamed: '已重命名',
} as const satisfies Record<FieldStatus, string>;

export const FIELD_TYPE_LABELS = {
  string: '文本',
  enum: '枚举',
  boolean: '布尔值',
  integer: '整数',
  float: '小数',
  datetime: '时间',
} as const satisfies Record<FieldType, string>;

export const INGEST_CONTENT_TYPE_NOTICE =
  '注意 Content-Type 必须保持 text/plain;charset=UTF-8，改成 application/json 会触发 CORS 预检并使 sendBeacon 失效。';

export const LOG_CLIENT_CODE = `// log-client.ts
export interface LogClientConfig {
  endpoint: string;   // https://log.example.com
  projectId: string;  // prj_01KABCDEF...
  secret: string;     // ingestSecret，可自行混淆
}

export type LogValue = string | boolean | number;

const encoder = new TextEncoder();
let cachedKey: Promise<CryptoKey> | null = null;

function importKey(secret: string): Promise<CryptoKey> {
  cachedKey ??= crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return cachedKey;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function buildEnvelope(
  config: LogClientConfig,
  data: Record<string, LogValue>,
): Promise<string> {
  const payload = JSON.stringify({
    recordId: crypto.randomUUID(),
    occurredAt: Date.now(),
    data,
  });

  const timestamp = Date.now();
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(8)).buffer);
  const signBase = \`\${config.projectId}\\n\${timestamp}\\n\${nonce}\\n\${payload}\`;
  const signature = toHex(
    await crypto.subtle.sign('HMAC', await importKey(config.secret), encoder.encode(signBase)),
  );

  return JSON.stringify({ p: config.projectId, t: timestamp, n: nonce, s: signature, d: payload });
}

/** 常规上报。失败只记录，不抛出，避免影响业务流程。 */
export async function report(
  config: LogClientConfig,
  data: Record<string, LogValue>,
): Promise<boolean> {
  try {
    const body = await buildEnvelope(config, data);
    const res = await fetch(\`\${config.endpoint}/api/ingest/v1/projects/\${config.projectId}/rows\`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body,
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 页面卸载场景。sendBeacon 无法重试，属于尽力而为。 */
export async function reportOnUnload(
  config: LogClientConfig,
  data: Record<string, LogValue>,
): Promise<boolean> {
  const body = await buildEnvelope(config, data);
  const blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
  return navigator.sendBeacon(\`\${config.endpoint}/api/ingest/v1/projects/\${config.projectId}/rows\`, blob);
}`;

export function getTableStatusActions(status: TableStatus): readonly TableStatusAction[] {
  return TABLE_STATUS_ACTIONS[status];
}

export function canRetryTable(status: TableStatus): boolean {
  return status === 'failed';
}

export function canDeleteTable(role: Role | undefined, status: TableStatus): boolean {
  return role === 'super_admin' && (status === 'archived' || status === 'failed');
}

export function canChangeFieldsInTableStatus(status: TableStatus): boolean {
  return status === 'active' || status === 'disabled';
}

export function canLoadRecentReports(status: TableStatus): boolean {
  return status !== 'creating' && status !== 'failed';
}

export function buildRecentReportQuery(now = Date.now()): DetailQueryInput {
  return {
    range: { start: now - 7 * 24 * 60 * 60 * 1_000, end: now },
    includeFields: [],
    limit: 20,
    order: 'desc',
  };
}

export function isFieldDeletionConfirmed(input: string, fieldKey: string): boolean {
  return input === fieldKey;
}

export function isTableDeletionConfirmed(input: string, displayName: string): boolean {
  return input === displayName;
}

export function groupFieldsByStatus(fields: readonly CollectionField[]): FieldsByStatus {
  const groups: FieldsByStatus = {
    active: [],
    deprecated: [],
    dropped: [],
    renamed: [],
  };
  for (const field of fields) {
    groups[field.status].push(field);
  }
  return groups;
}

export function getVisibleFields(
  fields: readonly CollectionField[],
  showTombstones: boolean,
): CollectionField[] {
  return fields.filter(
    (field) => showTombstones || (field.status !== 'dropped' && field.status !== 'renamed'),
  );
}

export function countPhysicalFields(fields: readonly CollectionField[]): number {
  return fields.filter((field) => field.status === 'active' || field.status === 'deprecated')
    .length;
}

function getExistingFieldKeyError(
  key: string,
  existingFields: readonly CollectionField[],
): string | undefined {
  const existing = existingFields.find((field) => field.key === key);
  if (existing?.status === 'active') {
    return 'Key 正被使用中的字段占用';
  }
  // 5.2：deprecated 的 Key 不可复用——物理列与历史数据都还在，同名重建会让元数据与物理列脱节。
  if (existing?.status === 'deprecated') {
    return 'Key 已被软废弃字段占用，需先物理删除该列才能复用';
  }
  return undefined;
}

export function validateFieldKey(
  key: string,
  existingFields: readonly CollectionField[],
): string | undefined {
  if (!FIELD_KEY_PATTERN.test(key)) {
    return 'Key 必须以小写字母开头，且只能包含小写字母、数字和下划线，最长 64 位';
  }
  return getExistingFieldKeyError(key, existingFields);
}

export function validateAddFieldForm(
  form: AddFieldFormValue,
  existingFields: readonly CollectionField[],
): FieldFormValidation {
  const key = validateFieldKey(form.key, existingFields);
  const label = form.label.trim() === '' ? '请输入字段名称' : undefined;
  const optionValidation = form.type === 'enum' ? validateEnumOptions(form.options) : undefined;
  const options =
    optionValidation !== undefined && !optionValidation.valid
      ? (optionValidation.form ?? '请修正枚举选项')
      : undefined;
  return {
    valid: key === undefined && label === undefined && options === undefined,
    ...(key === undefined ? {} : { key }),
    ...(label === undefined ? {} : { label }),
    ...(options === undefined ? {} : { options }),
  };
}

export function toCreateFieldInput(form: AddFieldFormValue): CreateFieldInput {
  return {
    key: form.key,
    label: form.label.trim(),
    type: form.type,
    required: form.required,
    description: form.description,
    ...(form.type === 'enum' ? { options: cloneEnumOptions(form.options) } : {}),
  };
}

const RETYPE_TOP_RANGE_MS = 92 * 24 * 60 * 60 * 1_000;

/** DESIGN 10.3：`string → enum` 弹窗先拉该字段的 Top 取值（9.4 的 field × count）。 */
export function buildRetypeTopValuesQuery(
  fieldKey: string,
  tz: string,
  now = Date.now(),
  limit = 200,
): StatisticsInput {
  return {
    range: { start: now - RETYPE_TOP_RANGE_MS, end: now },
    tz,
    dimension: { kind: 'field', field: fieldKey, limit },
    measure: { fn: 'count' },
  };
}

export function topGroupsToEnumOptions(rows: readonly StatisticsRow[]): FieldOptionInput[] {
  return rows.flatMap((row) =>
    canRegisterEnumValue(row.key)
      ? [{ value: row.key, label: row.key, status: 'active' as const }]
      : [],
  );
}

export function canRetypeField(field: Pick<CollectionField, 'status' | 'type'>): boolean {
  return field.status === 'active' && (field.type === 'string' || field.type === 'enum');
}

export function buildRetypeFieldInput(
  field: Pick<CollectionField, 'type'>,
  options: readonly FieldOptionInput[],
): RetypeFieldInput {
  return field.type === 'string'
    ? { type: 'enum', options: cloneEnumOptions(options) }
    : { type: 'string' };
}

export function buildUpdateFieldInput(
  field: CollectionField,
  form: EditFieldFormValue,
): UpdateFieldInput {
  const input: UpdateFieldInput = {};
  const label = form.label.trim();
  if (label !== field.label) {
    input.label = label;
  }
  if (form.required !== field.required) {
    input.required = form.required;
  }
  if (form.description !== field.description) {
    input.description = form.description;
  }
  return input;
}

export function validateEditFieldForm(
  field: CollectionField,
  form: EditFieldFormValue,
): FieldFormValidation {
  const label = form.label.trim() === '' ? '请输入字段名称' : undefined;
  const input = buildUpdateFieldInput(field, form);
  const formError = Object.keys(input).length === 0 ? '请至少修改一项字段配置' : undefined;
  return {
    valid: label === undefined && formError === undefined,
    ...(label === undefined ? {} : { label }),
    ...(formError === undefined ? {} : { form: formError }),
  };
}

function escapeSingleQuotedString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n');
}

export function buildIntegrationUsageCode(
  endpoint: string,
  projectId: string,
  secret: string,
  fields: readonly CollectionField[],
): string {
  const config = `const client: LogClientConfig = {
  endpoint: '${escapeSingleQuotedString(endpoint)}',
  projectId: '${escapeSingleQuotedString(projectId)}',
  secret: '${escapeSingleQuotedString(secret)}',
};`;
  const activeFields = fields.filter((field) => field.status === 'active');
  if (activeFields.length === 0) {
    return `${config}\n\nawait report(client, {});`;
  }
  const values = activeFields
    .map((field) => {
      const example = {
        string: "'示例字符串'",
        enum: "'示例选项'",
        boolean: 'true',
        integer: '0',
        float: '0.5',
        datetime: 'Date.now()',
      }[field.type];
      return `  ${field.key}: ${example},`;
    })
    .join('\n');
  return `${config}\n\nawait report(client, {\n${values}\n});`;
}
