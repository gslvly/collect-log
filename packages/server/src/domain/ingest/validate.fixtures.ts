import { expect } from 'vitest';

import { configuredLimits } from '../../config/limits.js';
import { AppError } from '../../errors.js';
import type { ActiveField } from '../tables/types.js';
import { validateFieldValues as validateFieldValuesWithLimits } from './validate.js';

export const now = 1_756_012_830_123;
const fields: ActiveField[] = [
  {
    key: 'event_name',
    label: 'Event name',
    type: 'string',
    required: true,
    description: '',
    activeOptions: new Map(),
    schemaVersion: 7,
  },
  {
    key: 'is_success',
    label: 'Success',
    type: 'boolean',
    required: false,
    description: '',
    activeOptions: new Map(),
    schemaVersion: 7,
  },
  {
    key: 'score',
    label: 'Score',
    type: 'float',
    required: false,
    description: '',
    activeOptions: new Map(),
    schemaVersion: 7,
  },
];
export const definition = {
  projectId: 'prj_01KABCDEF0123456789ABCDEFG',
  schemaVersion: 7,
  fields,
};
export const noRetiredFields = async () => [];

export function validateFieldValues(
  data: Parameters<typeof validateFieldValuesWithLimits>[0],
  tableDefinition: Parameters<typeof validateFieldValuesWithLimits>[1],
  listFields: Parameters<typeof validateFieldValuesWithLimits>[2],
  ingestLimits: Parameters<typeof validateFieldValuesWithLimits>[3],
) {
  return validateFieldValuesWithLimits(
    data,
    tableDefinition,
    listFields,
    ingestLimits,
    configuredLimits.schema,
  );
}

export function optionalField(
  key: string,
  type: ActiveField['type'],
  activeOptions: ReadonlyMap<string, string> = new Map(),
): ActiveField {
  return {
    key,
    label: key,
    type,
    required: false,
    description: '',
    activeOptions,
    schemaVersion: 7,
  };
}

export function definitionFor(...selectedFields: ActiveField[]) {
  return { ...definition, fields: selectedFields };
}

export function appError(error: unknown): AppError {
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}
