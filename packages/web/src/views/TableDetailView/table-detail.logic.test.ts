import { describe, expect, it } from 'vitest';

import { ERROR_MESSAGES } from '../../api/errors.js';
import {
  FIELD_STATUSES,
  TABLE_STATUSES,
  type CollectionField,
  type FieldStatus,
  type TableStatus,
} from '../../api/tables.js';
import { ROLES } from '../../permissions.js';
import {
  buildIntegrationUsageCode,
  buildRecentReportQuery,
  buildRetypeFieldInput,
  buildRetypeTopValuesQuery,
  buildUpdateFieldInput,
  canDeleteTable,
  canLoadRecentReports,
  canRetypeField,
  canRetryTable,
  countPhysicalFields,
  getTableStatusActions,
  getVisibleFields,
  groupFieldsByStatus,
  INGEST_CONTENT_TYPE_NOTICE,
  isFieldDeletionConfirmed,
  isTableDeletionConfirmed,
  LOG_CLIENT_CODE,
  topGroupsToEnumOptions,
  toCreateFieldInput,
  validateAddFieldForm,
  validateEditFieldForm,
} from './table-detail.logic.js';

function field(
  key: string,
  status: FieldStatus = 'active',
  type: CollectionField['type'] = 'string',
): CollectionField {
  return {
    key,
    label: `${key} label`,
    type,
    required: false,
    description: `${key} description`,
    options: [],
    status,
    renamedTo: status === 'renamed' ? `${key}_next` : '',
    schemaVersion: 2,
    createdAt: '2026-08-27T08:00:00.000Z',
    updatedAt: '2026-08-27T09:00:00.000Z',
  };
}

describe('table detail status actions', () => {
  it('exposes exactly the transitions allowed by DESIGN 5.1', () => {
    const targets = Object.fromEntries(
      TABLE_STATUSES.map((status) => [
        status,
        getTableStatusActions(status).map((action) => action.target),
      ]),
    ) as Record<TableStatus, TableStatus[]>;

    expect(targets).toEqual({
      creating: [],
      active: ['disabled', 'archived'],
      disabled: ['active', 'archived'],
      archived: ['active'],
      failed: ['archived'],
    });
    for (const status of TABLE_STATUSES) {
      for (const action of getTableStatusActions(status)) {
        expect(action.requiresConfirmation).toBe(
          action.target === 'disabled' || action.target === 'archived',
        );
      }
      expect(canRetryTable(status)).toBe(status === 'failed');
    }
  });

  it('enables table deletion only for super_admin in archived or failed state', () => {
    for (const role of ROLES) {
      for (const status of TABLE_STATUSES) {
        expect(canDeleteTable(role, status)).toBe(
          role === 'super_admin' && (status === 'archived' || status === 'failed'),
        );
      }
    }
  });

  it('builds the fixed recent-report query and skips only non-ready table states', () => {
    const now = Date.parse('2026-08-29T12:00:00.000Z');
    expect(buildRecentReportQuery(now)).toEqual({
      range: { start: now - 7 * 24 * 60 * 60 * 1_000, end: now },
      includeFields: [],
      limit: 20,
      order: 'desc',
    });
    expect(canLoadRecentReports('creating')).toBe(false);
    expect(canLoadRecentReports('failed')).toBe(false);
    expect(canLoadRecentReports('active')).toBe(true);
    expect(canLoadRecentReports('disabled')).toBe(true);
    expect(canLoadRecentReports('archived')).toBe(true);
  });
});

describe('destructive confirmation matching', () => {
  it('requires the exact field Key without trimming or case folding', () => {
    expect(isFieldDeletionConfirmed('event_name', 'event_name')).toBe(true);
    expect(isFieldDeletionConfirmed(' event_name', 'event_name')).toBe(false);
    expect(isFieldDeletionConfirmed('event_name ', 'event_name')).toBe(false);
    expect(isFieldDeletionConfirmed('Event_Name', 'event_name')).toBe(false);
  });

  it('requires the exact displayName without trimming or case folding', () => {
    expect(isTableDeletionConfirmed('订单事件', '订单事件')).toBe(true);
    expect(isTableDeletionConfirmed(' 订单事件', '订单事件')).toBe(false);
    expect(isTableDeletionConfirmed('订单事件 ', '订单事件')).toBe(false);
    expect(isTableDeletionConfirmed('Order Events', 'order events')).toBe(false);
  });
});

describe('field grouping and tombstone visibility', () => {
  const fields = [
    field('active_a'),
    field('dropped_b', 'dropped'),
    field('deprecated_c', 'deprecated'),
    field('renamed_d', 'renamed'),
    field('active_e'),
  ];

  it('groups every status without mutating the server order inside each group', () => {
    const groups = groupFieldsByStatus(fields);

    expect(Object.keys(groups)).toEqual(FIELD_STATUSES);
    expect(groups.active.map((item) => item.key)).toEqual(['active_a', 'active_e']);
    expect(groups.deprecated.map((item) => item.key)).toEqual(['deprecated_c']);
    expect(groups.dropped.map((item) => item.key)).toEqual(['dropped_b']);
    expect(groups.renamed.map((item) => item.key)).toEqual(['renamed_d']);
    expect(countPhysicalFields(fields)).toBe(3);
  });

  it('collapses tombstones by default and preserves the API order when expanded', () => {
    expect(getVisibleFields(fields, false).map((item) => item.key)).toEqual([
      'active_a',
      'deprecated_c',
      'active_e',
    ]);
    expect(getVisibleFields(fields, true).map((item) => item.key)).toEqual(
      fields.map((item) => item.key),
    );
  });
});

describe('field form validation', () => {
  const existingFields = [
    field('active_key'),
    field('deprecated_key', 'deprecated'),
    field('dropped_key', 'dropped'),
    field('renamed_key', 'renamed'),
  ];

  it('rejects invalid and duplicate active keys plus blank labels', () => {
    const invalid = validateAddFieldForm(
      {
        key: 'Event-Name',
        label: '   ',
        type: 'string',
        required: false,
        description: '',
        options: [],
      },
      existingFields,
    );
    expect(invalid).toMatchObject({
      valid: false,
      key: expect.any(String),
      label: expect.any(String),
    });

    expect(
      validateAddFieldForm(
        {
          key: 'active_key',
          label: '重复字段',
          type: 'string',
          required: false,
          description: '',
          options: [],
        },
        existingFields,
      ).key,
    ).toContain('占用');
    expect(
      validateAddFieldForm(
        {
          key: 'deprecated_key',
          label: '软废弃字段',
          type: 'string',
          required: false,
          description: '',
          options: [],
        },
        existingFields,
      ).key,
    ).toContain('先物理删除');
  });

  it('keeps server conflict messages distinct for active and soft-deprecated keys', () => {
    expect(ERROR_MESSAGES.FIELD_KEY_EXISTS).toContain('使用中');
    expect(ERROR_MESSAGES.FIELD_KEY_RETIRED).toContain('先物理删除');
    expect(ERROR_MESSAGES.FIELD_KEY_EXISTS).not.toBe(ERROR_MESSAGES.FIELD_KEY_RETIRED);
  });

  it('allows dropped and renamed tombstone keys to be rebuilt', () => {
    for (const key of ['dropped_key', 'renamed_key']) {
      const form = {
        key,
        label: '重建字段',
        type: 'boolean' as const,
        required: true,
        description: '全新的空列',
        options: [],
      };
      expect(validateAddFieldForm(form, existingFields)).toEqual({ valid: true });
      expect(toCreateFieldInput({ ...form, label: '  重建字段  ' })).toMatchObject({
        key,
        label: '重建字段',
        type: 'boolean',
      });
    }
  });

  it('validates and serializes enum options only for enum fields', () => {
    const enumForm = {
      key: 'channel',
      label: '渠道',
      type: 'enum' as const,
      required: true,
      description: '',
      options: [
        { value: 'web', label: '网页', status: 'active' as const },
        { value: 'app', label: '应用', status: 'disabled' as const },
      ],
    };
    expect(validateAddFieldForm(enumForm, existingFields)).toEqual({ valid: true });
    expect(toCreateFieldInput(enumForm)).toMatchObject({ options: enumForm.options });

    const invalid = validateAddFieldForm(
      { ...enumForm, options: [{ value: '', label: '', status: 'disabled' }] },
      existingFields,
    );
    expect(invalid).toMatchObject({ valid: false, options: expect.any(String) });
    expect(
      toCreateFieldInput({ ...enumForm, type: 'string', options: enumForm.options }),
    ).not.toHaveProperty('options');
  });

  it('requires a PATCH form to change at least one editable property', () => {
    const current = field('event_name');
    const unchanged = {
      label: current.label,
      required: current.required,
      description: current.description,
    };
    expect(validateEditFieldForm(current, unchanged)).toMatchObject({
      valid: false,
      form: expect.any(String),
    });
    expect(
      validateEditFieldForm(current, { ...unchanged, label: '   ', required: true }),
    ).toMatchObject({ valid: false, label: expect.any(String) });

    const changed = { ...unchanged, required: true };
    expect(validateEditFieldForm(current, changed)).toEqual({ valid: true });
    expect(buildUpdateFieldInput(current, changed)).toEqual({ required: true });
  });
});

describe('string and enum conversion helpers', () => {
  it('builds the current Top-value request over the maximum 92-day range', () => {
    const now = Date.parse('2026-08-30T12:00:00.000Z');
    expect(buildRetypeTopValuesQuery('event_name', 'Asia/Shanghai', now)).toEqual({
      range: { start: now - 92 * 24 * 60 * 60 * 1_000, end: now },
      tz: 'Asia/Shanghai',
      dimension: { kind: 'field', field: 'event_name', limit: 200 },
      measure: { fn: 'count' },
    });
  });

  it('prefills registerable Top values and exposes only the lossless conversion pair', () => {
    expect(
      topGroupsToEnumOptions([
        { key: 'checkout', value: 12, rows: 12 },
        { key: '', value: 2, rows: 2 },
        { key: 42, value: 1, rows: 1 },
        { key: true, value: 1, rows: 1 },
        { key: null, value: 3, rows: 3 },
        { key: 'login', value: 8, rows: 8 },
      ]),
    ).toEqual([
      { value: 'checkout', label: 'checkout', status: 'active' },
      { value: 'login', label: 'login', status: 'active' },
    ]);
    const stringField = field('event_name');
    expect(canRetypeField(stringField)).toBe(true);
    expect(buildRetypeFieldInput(stringField, topGroupsToEnumOptions([]))).toEqual({
      type: 'enum',
      options: [],
    });
    const enumField = { ...field('channel', 'active', 'enum'), options: [] };
    expect(buildRetypeFieldInput(enumField, [])).toEqual({ type: 'string' });
    expect(canRetypeField(field('count', 'active', 'integer'))).toBe(false);
    expect(canRetypeField(field('legacy', 'deprecated'))).toBe(false);
  });
});

describe('integration example assembly', () => {
  it('keeps the prescribed client and injects the current endpoint, ID, secret and active fields', () => {
    const fields = [
      field('user_id'),
      field('is_new_device', 'active', 'boolean'),
      field('score', 'active', 'float'),
      field('legacy_field', 'deprecated'),
      field('old_key', 'renamed'),
    ];
    const usage = buildIntegrationUsageCode(
      'https://logs.example.com',
      'prj_01KABCDEF12345678901234567',
      'current-secret',
      fields,
    );

    expect(LOG_CLIENT_CODE.startsWith('// log-client.ts\nexport interface LogClientConfig')).toBe(
      true,
    );
    expect(LOG_CLIENT_CODE).toContain(
      'const signBase = `${config.projectId}\\n${timestamp}\\n${nonce}\\n${payload}`;',
    );
    expect(LOG_CLIENT_CODE).toContain('export type LogValue = string | boolean | number;');
    expect(LOG_CLIENT_CODE).toContain("headers: { 'Content-Type': 'text/plain;charset=UTF-8' }");
    expect(usage).toContain("endpoint: 'https://logs.example.com'");
    expect(usage).toContain("projectId: 'prj_01KABCDEF12345678901234567'");
    expect(usage).toContain("secret: 'current-secret'");
    expect(usage).toContain("user_id: '示例字符串'");
    expect(usage).toContain('is_new_device: true');
    expect(usage).toContain('score: 0');
    expect(usage).not.toContain('legacy_field');
    expect(usage).not.toContain('old_key');
    expect(INGEST_CONTENT_TYPE_NOTICE).toContain('application/json 会触发 CORS 预检');
  });
});
