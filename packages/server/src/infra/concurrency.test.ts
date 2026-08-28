import { describe, expect, it } from 'vitest';

import { ConcurrencyGate } from './concurrency.js';

describe('ConcurrencyGate', () => {
  it('acquires up to capacity, rejects overflow, and can be reused after release', () => {
    const gate = new ConcurrencyGate(2);

    expect(gate.inFlight).toBe(0);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.inFlight).toBe(2);
    expect(gate.tryAcquire()).toBe(false);

    gate.release();
    expect(gate.inFlight).toBe(1);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.inFlight).toBe(2);
  });

  it('rejects invalid capacities and unbalanced releases', () => {
    expect(() => new ConcurrencyGate(0)).toThrow('positive safe integer');
    expect(() => new ConcurrencyGate(1).release()).toThrow('no in-flight work');
  });
});
