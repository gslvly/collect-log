import { describe, expect, it } from 'vitest';

import { NonceCache } from './nonce.js';

describe('ingest nonce LRU', () => {
  it('isolates nonce keys by project and rejects a replay', () => {
    const cache = new NonceCache(2, 1_000, () => 10_000);

    expect(cache.consume('project-a', '0000000000000001')).toBe(true);
    expect(cache.consume('project-a', '0000000000000001')).toBe(false);
    expect(cache.consume('project-b', '0000000000000001')).toBe(true);
    cache.close();
  });

  it('evicts the least recently used entry at capacity', () => {
    const cache = new NonceCache(2, 1_000, () => 10_000);

    expect(cache.consume('project', '0000000000000001')).toBe(true);
    expect(cache.consume('project', '0000000000000002')).toBe(true);
    expect(cache.consume('project', '0000000000000001')).toBe(false);
    expect(cache.consume('project', '0000000000000003')).toBe(true);
    expect(cache.consume('project', '0000000000000002')).toBe(true);
    cache.close();
  });

  it('treats an entry as new after its injected-clock TTL expires', () => {
    let now = 10_000;
    const cache = new NonceCache(2, 1_000, () => now);

    expect(cache.consume('project', '0000000000000001')).toBe(true);
    now += 999;
    expect(cache.consume('project', '0000000000000001')).toBe(false);
    now += 1;
    expect(cache.consume('project', '0000000000000001')).toBe(true);
    cache.close();
  });
});
