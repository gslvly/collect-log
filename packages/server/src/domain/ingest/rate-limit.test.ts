import { describe, expect, it } from 'vitest';

import { ERROR_HTTP_STATUS, AppError } from '../../errors.js';
import { IngestRateLimiter, TokenBucketRateLimiter } from './rate-limit.js';

function consumeOrThrow(limiter: IngestRateLimiter, ip: string, projectId: string): void {
  if (!limiter.consumeIp(ip) || !limiter.consumeProject(projectId)) {
    throw new AppError('RATE_LIMITED', 'Ingest rate limit exceeded');
  }
}

describe('ingest token buckets', () => {
  it('exhausts capacity and replenishes tokens at the per-second rate', () => {
    let now = 10_000;
    const limiter = new TokenBucketRateLimiter(2, () => now);

    expect(limiter.consume('key')).toBe(true);
    expect(limiter.consume('key')).toBe(true);
    expect(limiter.consume('key')).toBe(false);
    now += 500;
    expect(limiter.consume('key')).toBe(true);
    expect(limiter.consume('key')).toBe(false);
    now += 1_000;
    expect(limiter.consume('key')).toBe(true);
    expect(limiter.consume('key')).toBe(true);
    limiter.close();
  });

  it('limits IP and project buckets independently and maps exhaustion to HTTP 429', () => {
    const limiter = new IngestRateLimiter(1, 1, () => 10_000);

    consumeOrThrow(limiter, '192.0.2.1', 'project-a');
    try {
      consumeOrThrow(limiter, '192.0.2.2', 'project-a');
      throw new Error('Expected the project token bucket to be exhausted');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('RATE_LIMITED');
      expect(ERROR_HTTP_STATUS[(error as AppError).code]).toBe(429);
    }
    limiter.close();
  });
});
