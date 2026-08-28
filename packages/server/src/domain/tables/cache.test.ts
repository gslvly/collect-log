import { describe, expect, it, vi } from 'vitest';

import { TableMetadataCache } from './cache.js';
import type { TableDefinition } from './types.js';

function definition(status: TableDefinition['status'] = 'active'): TableDefinition {
  return {
    projectId: 'prj_01KABCDEF0123456789ABCDEFG',
    physicalName: 'collect_a8f31c',
    displayName: 'Events',
    description: '',
    status,
    schemaVersion: 1,
    ingestSecret: 'secret',
    ingestSecretPrev: '',
    ingestSecretPrevExpiresAt: null,
    createdBy: 'admin',
    createdAt: '2026-08-27 00:00:00.000',
    updatedAt: '2026-08-27 00:00:00.000',
    fields: [
      {
        key: 'result',
        label: 'Result',
        type: 'string',
        required: true,
        description: '',
        schemaVersion: 1,
      },
    ],
  };
}

describe('table metadata cache', () => {
  it('caches the merged table and active-field definition', async () => {
    const cache = new TableMetadataCache();
    const loader = vi.fn(async () => definition());

    const [first, second] = await Promise.all([
      cache.get('table', loader),
      cache.get('table', loader),
    ]);

    expect(first).toEqual(definition());
    expect(second?.fields).toHaveLength(1);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('reloads after per-table invalidation and supports test-wide clearing', async () => {
    const cache = new TableMetadataCache();
    const loader = vi
      .fn<() => Promise<TableDefinition | null>>()
      .mockResolvedValueOnce(definition())
      .mockResolvedValue(definition('disabled'));

    await cache.get('table', loader);
    cache.invalidate('table');
    await expect(cache.get('table', loader)).resolves.toMatchObject({ status: 'disabled' });
    expect(loader).toHaveBeenCalledTimes(2);

    cache.clear();
    expect(cache.has('table')).toBe(false);
  });

  it('does not retain a rejected load', async () => {
    const cache = new TableMetadataCache();
    const loader = vi
      .fn<() => Promise<TableDefinition | null>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(definition());

    await expect(cache.get('table', loader)).rejects.toThrow('temporary failure');
    await expect(cache.get('table', loader)).resolves.toEqual(definition());
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('does not retain a missing definition', async () => {
    const cache = new TableMetadataCache();
    await expect(cache.get('missing', async () => null)).resolves.toBeNull();
    expect(cache.has('missing')).toBe(false);
  });

  it('evicts the earliest entry when capacity is exceeded', async () => {
    const cache = new TableMetadataCache(2);
    await cache.get('first', async () => definition());
    await cache.get('second', async () => definition());
    await cache.get('third', async () => definition());
    expect(cache.has('first')).toBe(false);
    expect(cache.has('second')).toBe(true);
    expect(cache.has('third')).toBe(true);
  });
});
