import {
  type CollectionTable,
  type CreateFieldInput,
  type CreateTableInput,
  type TableStatus,
  type TableTemplate,
} from '../../api/tables.js';
import { validateEnumOptions } from '../../enum-options.logic.js';

export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const TABLE_STATUS_LABELS = {
  creating: '创建中',
  active: '已启用',
  disabled: '已停用',
  archived: '已归档',
  failed: '失败',
} as const satisfies Record<TableStatus, string>;

export const TABLE_STATUS_TAG_TYPES = {
  creating: 'warning',
  active: 'success',
  disabled: 'info',
  archived: 'info',
  failed: 'danger',
} as const satisfies Record<TableStatus, 'warning' | 'success' | 'info' | 'danger'>;

export type TableSort = 'createdAtDesc' | 'createdAtAsc' | 'displayNameAsc' | 'displayNameDesc';

export interface CreateTableFormValue {
  displayName: string;
  description: string;
  fields: CreateFieldInput[];
}

interface FieldValidationErrors {
  key?: string;
  label?: string;
  options?: string;
}

export interface CreateTableValidation {
  valid: boolean;
  displayName?: string;
  fields: FieldValidationErrors[];
}

export function getTableStatusLabel(status: TableStatus): string {
  return TABLE_STATUS_LABELS[status];
}

export function applyTableTemplate(
  current: CreateTableFormValue,
  template: TableTemplate,
): CreateTableFormValue {
  return {
    displayName: current.displayName,
    description: template.description,
    fields: template.fields.map((field) => ({
      ...field,
      ...(field.options === undefined
        ? {}
        : { options: field.options.map((option) => ({ ...option })) }),
    })),
  };
}

export function hasTemplateContentToOverwrite(
  form: Pick<CreateTableFormValue, 'description' | 'fields'>,
): boolean {
  return form.description !== '' || form.fields.length > 0;
}

export function validateCreateTableForm(form: CreateTableFormValue): CreateTableValidation {
  const keyCounts = new Map<string, number>();
  for (const field of form.fields) {
    keyCounts.set(field.key, (keyCounts.get(field.key) ?? 0) + 1);
  }

  const fieldErrors = form.fields.map((field): FieldValidationErrors => {
    const errors: FieldValidationErrors = {};
    if (!FIELD_KEY_PATTERN.test(field.key)) {
      errors.key = 'Key 必须以小写字母开头，且只能包含小写字母、数字和下划线，最长 64 位';
    } else if ((keyCounts.get(field.key) ?? 0) > 1) {
      errors.key = '同一张表内的字段 Key 不能重复';
    }
    if (field.label.trim() === '') {
      errors.label = '请输入字段名称';
    }
    if (field.type === 'enum') {
      const optionValidation = validateEnumOptions(field.options ?? []);
      if (!optionValidation.valid) {
        errors.options = optionValidation.form ?? '请修正枚举选项';
      }
    }
    return errors;
  });

  const displayNameError = form.displayName.trim() === '' ? '请输入数据采集表名称' : undefined;
  const valid =
    displayNameError === undefined &&
    fieldErrors.every(
      (errors) =>
        errors.key === undefined && errors.label === undefined && errors.options === undefined,
    );

  return {
    valid,
    ...(displayNameError === undefined ? {} : { displayName: displayNameError }),
    fields: fieldErrors,
  };
}

export function toCreateTableInput(form: CreateTableFormValue): CreateTableInput {
  return {
    displayName: form.displayName.trim(),
    description: form.description,
    fields: form.fields.map((field) => ({
      key: field.key,
      label: field.label.trim(),
      type: field.type,
      required: field.required,
      description: field.description,
      ...(field.options === undefined
        ? {}
        : { options: field.options.map((option) => ({ ...option })) }),
    })),
  };
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'zh-CN');
}

function compareTables(left: CollectionTable, right: CollectionTable, sort: TableSort): number {
  if (sort === 'createdAtDesc') {
    return (
      right.createdAt.localeCompare(left.createdAt) || compareText(left.projectId, right.projectId)
    );
  }
  if (sort === 'createdAtAsc') {
    return (
      left.createdAt.localeCompare(right.createdAt) || compareText(left.projectId, right.projectId)
    );
  }
  if (sort === 'displayNameDesc') {
    return (
      compareText(right.displayName, left.displayName) ||
      compareText(left.projectId, right.projectId)
    );
  }
  return (
    compareText(left.displayName, right.displayName) || compareText(left.projectId, right.projectId)
  );
}

export function filterAndSortTables(
  tables: readonly CollectionTable[],
  search: string,
  status: TableStatus | 'all',
  sort: TableSort,
): CollectionTable[] {
  const keyword = search.trim().toLocaleLowerCase('zh-CN');
  return tables
    .filter((table) => status === 'all' || table.status === status)
    .filter((table) => {
      if (keyword === '') {
        return true;
      }
      return [table.displayName, table.projectId, table.description, table.createdBy].some(
        (value) => value.toLocaleLowerCase('zh-CN').includes(keyword),
      );
    })
    .sort((left, right) => compareTables(left, right, sort));
}
