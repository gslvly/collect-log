import { describe, expect, it } from 'vitest';

import {
  authorization,
  createFixture,
  query,
  queryRange,
  statistics,
} from './query.integration.fixtures.js';

describe('stage D query routes against SQLite and ClickHouse', () => {
  it('explicitly selects, filters, exports, and aggregates deprecated field history', async () => {
    const fixture = await createFixture();
    const deprecated = await fixture.tables.deprecateField(fixture.projectId, 'note');
    expect(deprecated).toMatchObject({
      table: { schemaVersion: 2 },
      field: { key: 'note', status: 'deprecated', schemaVersion: 2 },
    });

    const defaultDetail = await query(fixture, {
      range: queryRange,
      limit: 5,
      order: 'asc',
    });
    expect(defaultDetail.statusCode, defaultDetail.body).toBe(200);
    expect(
      defaultDetail.json().rows.every((row: Record<string, unknown>) => !('note' in row)),
    ).toBe(true);

    const includedDetail = await query(fixture, {
      range: queryRange,
      includeFields: ['note'],
      limit: 5,
      order: 'asc',
    });
    expect(includedDetail.statusCode, includedDetail.body).toBe(200);
    const includedRows = includedDetail.json().rows as Array<Record<string, unknown>>;
    expect(Object.keys(includedRows[0] ?? {}).slice(4)).toEqual([
      'event_name',
      'is_success',
      'note',
      'user_id',
    ]);
    expect(includedRows[1]).toMatchObject({
      _record_id: fixture.recordIds[1],
      note: 'explicit note',
    });
    expect(includedRows[0]).toHaveProperty('note', null);

    const filtered = await query(fixture, {
      range: queryRange,
      filter: { field: 'note', op: 'eq', value: 'explicit note' },
    });
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json().rows).toHaveLength(1);
    expect(filtered.json().rows[0]).toMatchObject({ _record_id: fixture.recordIds[1] });
    expect(filtered.json().rows[0]).not.toHaveProperty('note');

    const unique = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      measure: { fn: 'unique', field: 'note' },
    });
    expect(unique.statusCode, unique.body).toBe(200);
    expect(unique.json()).toEqual({
      dimension: null,
      measure: { fn: 'unique', field: 'note' },
      rows: [{ value: 1, rows: 5 }],
      totals: { value: 1, rows: 5 },
      truncated: false,
    });

    // DESIGN 9.4：deprecated 字段在 dimension.field 处同样直接放行。
    const deprecatedGroups = await statistics(fixture, {
      range: queryRange,
      tz: 'UTC',
      dimension: { kind: 'field', field: 'note' },
      measure: { fn: 'count' },
    });
    expect(deprecatedGroups.statusCode, deprecatedGroups.body).toBe(200);
    expect(deprecatedGroups.json().rows).toEqual([
      { key: null, value: 4, rows: 4, share: 0.8 },
      { key: 'explicit note', value: 1, rows: 1, share: 0.2 },
    ]);

    const exported = await fixture.app.inject({
      method: 'POST',
      url: `/api/admin/tables/${fixture.projectId}/export`,
      headers: authorization(fixture.app, 'user'),
      payload: { range: queryRange, includeFields: ['note'], order: 'asc' },
    });
    expect(exported.statusCode, exported.body).toBe(200);
    const exportHeader = exported.body.split('\n')[0] ?? '';
    expect(exportHeader.indexOf('event_name')).toBeLessThan(exportHeader.indexOf('is_success'));
    expect(exportHeader.indexOf('is_success')).toBeLessThan(exportHeader.indexOf('note'));
    expect(exportHeader.indexOf('note')).toBeLessThan(exportHeader.indexOf('user_id'));
    expect(exported.body).toContain('explicit note');

    const rejectedExport = await fixture.app.inject({
      method: 'POST',
      url: `/api/admin/tables/${fixture.projectId}/export`,
      headers: authorization(fixture.app, 'user'),
      payload: { range: queryRange, includeFields: ['missing_field'], order: 'asc' },
    });
    expect(rejectedExport.statusCode, rejectedExport.body).toBe(400);
    expect(rejectedExport.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });

    const firstPage = await query(fixture, {
      range: queryRange,
      includeFields: ['note'],
      limit: 1,
    });
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    expect(firstPage.json().nextCursor).toEqual(expect.any(String));
    const changedColumns = await query(fixture, {
      range: queryRange,
      includeFields: [],
      limit: 1,
      cursor: firstPage.json().nextCursor,
    });
    expect(changedColumns.statusCode, changedColumns.body).toBe(400);
    expect(changedColumns.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });

    const invalidBeforeRetirement = [
      { key: 'missing_field', message: 'Unknown field' },
      { key: '_record_id', message: 'System field' },
      { key: 'event_name', message: 'already selected by default' },
    ];
    for (const invalid of invalidBeforeRetirement) {
      const response = await query(fixture, {
        range: queryRange,
        includeFields: [invalid.key],
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });
      expect(response.json().error.message).toContain(invalid.message);
    }

    await fixture.tables.dropField(fixture.projectId, 'user_id', 'user_id');
    await fixture.tables.renameField(fixture.projectId, 'is_success', 'success_flag');
    for (const invalid of [
      { key: 'user_id', status: 'dropped' },
      { key: 'is_success', status: 'renamed' },
    ]) {
      const response = await query(fixture, {
        range: queryRange,
        includeFields: [invalid.key],
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });
      expect(response.json().error.message).toContain(`status "${invalid.status}"`);
    }

    for (const condition of [
      { field: 'user_id', op: 'eq', value: 'u1' },
      { field: 'is_success', op: 'eq', value: true },
      { field: 'missing_field', op: 'eq', value: 'x' },
      { field: '_record_id', op: 'eq', value: fixture.recordIds[0] },
    ]) {
      const response = await query(fixture, { range: queryRange, filter: condition });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });
    }

    for (const input of [
      // dropped / renamed / 未知字段 / 系统列在 measure 与 dimension 两处都必须被拒。
      { measure: { fn: 'unique', field: 'user_id' } },
      { measure: { fn: 'unique', field: 'is_success' } },
      { measure: { fn: 'unique', field: 'missing_field' } },
      { measure: { fn: 'unique', field: '_record_id' } },
      { dimension: { kind: 'field', field: 'user_id' }, measure: { fn: 'count' } },
      { dimension: { kind: 'field', field: '_record_id' }, measure: { fn: 'count' } },
      {
        dimension: { kind: 'time', axis: 'user_id', granularity: 'day' },
        measure: { fn: 'count' },
      },
    ]) {
      const response = await statistics(fixture, {
        range: queryRange,
        tz: 'UTC',
        ...input,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });
    }
  });
});
