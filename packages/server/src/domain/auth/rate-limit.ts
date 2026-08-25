import { configuredLimits } from '../../config/limits.js';

interface RateLimitWindow {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 60_000;

export class FixedWindowRateLimiter {
  readonly #windows = new Map<string, RateLimitWindow>();
  readonly #cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly limit: number,
    private readonly now: () => number = Date.now,
  ) {
    this.#cleanupTimer = setInterval(() => this.cleanupExpired(), WINDOW_MS);
    this.#cleanupTimer.unref();
  }

  consume(ip: string): boolean {
    const now = this.now();
    const current = this.#windows.get(ip);

    if (current === undefined || current.resetAt <= now) {
      this.#windows.set(ip, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }
    if (current.count >= this.limit) {
      return false;
    }

    current.count += 1;
    return true;
  }

  close(): void {
    clearInterval(this.#cleanupTimer);
    this.#windows.clear();
  }

  private cleanupExpired(): void {
    const now = this.now();
    for (const [ip, window] of this.#windows) {
      if (window.resetAt <= now) {
        this.#windows.delete(ip);
      }
    }
  }
}

export class LoginRateLimiter extends FixedWindowRateLimiter {
  constructor(limit = configuredLimits.auth.loginRateLimitPerIp, now: () => number = Date.now) {
    super(limit, now);
  }
}

// /api/auth/captcha 是匿名接口，不限流就能被无成本地刷爆进程内 Map。
export class CaptchaRateLimiter extends FixedWindowRateLimiter {
  constructor(limit = configuredLimits.auth.captchaRateLimitPerIp, now: () => number = Date.now) {
    super(limit, now);
  }
}
