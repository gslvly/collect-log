import { describe, expect, it } from 'vitest';

import type { ActiveField } from '../tables/types.js';
import { buildIngestRow, formatOccurredAt } from './writer.js';

const fields: ActiveField[] = [
  {
    key: 'event_name',
    label: 'Event name',
    type: 'string',
    required: true,
    description: '',
    schemaVersion: 7,
  },
  {
    key: 'is_success',
    label: 'Success',
    type: 'boolean',
    required: false,
    description: '',
    schemaVersion: 7,
  },
];

describe('ingest row construction', () => {
  it('formats occurredAt as UTC DateTime64(3) text', () => {
    expect(formatOccurredAt(Date.UTC(2025, 7, 24, 5, 20, 30, 123))).toBe('2025-08-24 05:20:30.123');
  });

  it('always builds the complete active column set without _received_at', () => {
    const row = buildIngestRow(
      { schemaVersion: 7, fields },
      {
        recordId: 'bea94960-7fbe-4853-a689-8a309c471627',
        occurredAt: Date.UTC(2025, 7, 24, 5, 20, 30, 123),
      },
      { event_name: 'login', is_success: null },
    );

    expect(row).toEqual({
      _record_id: 'bea94960-7fbe-4853-a689-8a309c471627',
      _schema_version: 7,
      _occurred_at: '2025-08-24 05:20:30.123',
      event_name: 'login',
      is_success: null,
    });
    expect(row).not.toHaveProperty('_received_at');
  });
});
