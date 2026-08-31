import type { FieldOptionInput } from './api/tables.js';

export interface EnumOptionItemErrors {
  value?: string;
  label?: string;
}

export interface EnumOptionsValidation {
  valid: boolean;
  form?: string;
  items: EnumOptionItemErrors[];
}

export function newEnumOption(): FieldOptionInput {
  return { value: '', label: '', status: 'active' };
}

export function cloneEnumOptions(options: readonly FieldOptionInput[]): FieldOptionInput[] {
  return options.map((option) => ({ ...option }));
}

export function validateEnumOptions(options: readonly FieldOptionInput[]): EnumOptionsValidation {
  const valueCounts = new Map<string, number>();
  for (const option of options) {
    valueCounts.set(option.value, (valueCounts.get(option.value) ?? 0) + 1);
  }
  const items = options.map((option): EnumOptionItemErrors => {
    const value = option.value.trim() === '' ? '请输入选项值' : undefined;
    const duplicate = (valueCounts.get(option.value) ?? 0) > 1;
    const label = option.label.trim() === '' ? '请输入展示名称' : undefined;
    return {
      ...(value === undefined && !duplicate
        ? {}
        : { value: value ?? '同一字段内的选项值不能重复' }),
      ...(label === undefined ? {} : { label }),
    };
  });
  const form = options.some((option) => option.status === 'active')
    ? undefined
    : '至少保留一个启用选项';
  const valid =
    options.length > 0 &&
    form === undefined &&
    items.every((item) => item.value === undefined && item.label === undefined);
  return {
    valid,
    ...(options.length === 0
      ? { form: '枚举字段至少需要一个启用选项' }
      : form === undefined
        ? {}
        : { form }),
    items,
  };
}

export function moveEnumOption(
  options: readonly FieldOptionInput[],
  fromIndex: number,
  toIndex: number,
): FieldOptionInput[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= options.length ||
    toIndex >= options.length
  ) {
    return cloneEnumOptions(options);
  }
  const next = cloneEnumOptions(options);
  const [moved] = next.splice(fromIndex, 1);
  if (moved !== undefined) {
    next.splice(toIndex, 0, moved);
  }
  return next;
}

export function hasNewlyDisabledOption(
  existing: readonly FieldOptionInput[],
  next: readonly FieldOptionInput[],
): boolean {
  const existingStatus = new Map(existing.map((option) => [option.value, option.status]));
  return next.some(
    (option) => option.status === 'disabled' && existingStatus.get(option.value) === 'active',
  );
}

export function canRegisterEnumValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  );
}
