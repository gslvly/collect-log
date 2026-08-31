import type { ActiveField, TableDefinition } from '../tables/types.js';

export const fields: ActiveField[] = [
  {
    key: 'event_name',
    label: 'Event name',
    type: 'string',
    required: false,
    description: '',
    activeOptions: new Map(),
    schemaVersion: 3,
  },
  {
    key: 'is_success',
    label: 'Success',
    type: 'boolean',
    required: false,
    description: '',
    activeOptions: new Map(),
    schemaVersion: 3,
  },
];

const floatField: ActiveField = {
  key: 'score',
  label: 'Score',
  type: 'float',
  required: false,
  description: '',
  activeOptions: new Map(),
  schemaVersion: 3,
};
export const fieldsWithFloat = [...fields, floatField];
const integerField: ActiveField = {
  key: 'retry_count',
  label: 'Retry count',
  type: 'integer',
  required: false,
  description: '',
  activeOptions: new Map(),
  schemaVersion: 3,
};
export const fieldsWithInteger = [...fields, integerField];
const datetimeField: ActiveField = {
  key: 'business_at',
  label: 'Business time',
  type: 'datetime',
  required: false,
  description: '',
  activeOptions: new Map(),
  schemaVersion: 3,
};
export const fieldsWithDatetime = [...fields, datetimeField];
export const fieldsWithNumbers = [...fields, floatField, integerField, datetimeField];

export const definition: TableDefinition = {
  projectId: 'prj_01K3QJ4SMNTN8Y5F5RZ6J7B8C9',
  physicalName: 'collect_deadbeef',
  displayName: 'Query fixture',
  description: '',
  status: 'active',
  schemaVersion: 3,
  ingestSecret: '',
  ingestSecretPrev: '',
  ingestSecretPrevExpiresAt: null,
  createdBy: 'tester',
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
  fields,
};
