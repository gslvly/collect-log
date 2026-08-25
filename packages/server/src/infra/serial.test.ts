import { describe, expect, it } from 'vitest';

import { serial } from './serial.js';

describe('serial', () => {
  it('runs concurrent tasks without overlap and continues after a rejection', async () => {
    let active = 0;
    let maxActive = 0;
    const started: number[] = [];
    const completed: number[] = [];

    const tasks = Array.from({ length: 10 }, (_, index) =>
      serial(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started.push(index);

        try {
          await new Promise((resolve) => setTimeout(resolve, 2));
          if (index === 4) {
            throw new Error('expected failure');
          }
          completed.push(index);
        } finally {
          active -= 1;
        }
      }),
    );

    const results = await Promise.allSettled(tasks);

    expect(maxActive).toBe(1);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(completed).toEqual([0, 1, 2, 3, 5, 6, 7, 8, 9]);
    expect(results[4]).toMatchObject({ status: 'rejected' });
    expect(results[9]).toMatchObject({ status: 'fulfilled' });
  });
});
