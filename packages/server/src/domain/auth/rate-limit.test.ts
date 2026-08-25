import { describe, expect, it } from 'vitest';

import { CaptchaRateLimiter, LoginRateLimiter } from './rate-limit.js';

describe('LoginRateLimiter', () => {
  it('limits each IP independently to the configured number per minute', () => {
    let now = 1_000;
    const limiter = new LoginRateLimiter(2, () => now);

    expect(limiter.consume('192.0.2.1')).toBe(true);
    expect(limiter.consume('192.0.2.1')).toBe(true);
    expect(limiter.consume('192.0.2.1')).toBe(false);
    expect(limiter.consume('192.0.2.2')).toBe(true);

    now += 60_000;
    expect(limiter.consume('192.0.2.1')).toBe(true);
    limiter.close();
  });

  it('applies the same fixed window to captcha issuance', () => {
    let now = 1_000;
    const limiter = new CaptchaRateLimiter(2, () => now);

    expect(limiter.consume('192.0.2.1')).toBe(true);
    expect(limiter.consume('192.0.2.1')).toBe(true);
    expect(limiter.consume('192.0.2.1')).toBe(false);

    now += 60_000;
    expect(limiter.consume('192.0.2.1')).toBe(true);
    limiter.close();
  });
});
