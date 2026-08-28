import { configuredLimits } from '../../config/limits.js';

interface TokenBucket {
  tokens: number;
  updatedAt: number;
}

const CLEANUP_INTERVAL_MS = 60_000;

export class TokenBucketRateLimiter {
  readonly #buckets = new Map<string, TokenBucket>();
  readonly #cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly capacity: number,
    private readonly now: () => number = Date.now,
  ) {
    this.#cleanupTimer = setInterval(() => this.cleanupIdle(), CLEANUP_INTERVAL_MS);
    this.#cleanupTimer.unref();
  }

  consume(key: string): boolean {
    const now = this.now();
    const current = this.#buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const elapsedMs = Math.max(0, now - current.updatedAt);
    current.tokens = Math.min(this.capacity, current.tokens + (elapsedMs * this.capacity) / 1_000);
    current.updatedAt = Math.max(current.updatedAt, now);

    if (current.tokens < 1) {
      this.#buckets.set(key, current);
      return false;
    }

    current.tokens -= 1;
    this.#buckets.set(key, current);
    return true;
  }

  close(): void {
    clearInterval(this.#cleanupTimer);
    this.#buckets.clear();
  }

  private cleanupIdle(): void {
    const now = this.now();
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.updatedAt >= CLEANUP_INTERVAL_MS) {
        this.#buckets.delete(key);
      }
    }
  }
}

export class IngestRateLimiter {
  readonly #perIp: TokenBucketRateLimiter;
  readonly #perProject: TokenBucketRateLimiter;

  constructor(
    perIp = configuredLimits.ingest.rateLimitPerIp,
    perProject = configuredLimits.ingest.rateLimitPerTable,
    now: () => number = Date.now,
  ) {
    this.#perIp = new TokenBucketRateLimiter(perIp, now);
    this.#perProject = new TokenBucketRateLimiter(perProject, now);
  }

  consumeIp(ip: string): boolean {
    return this.#perIp.consume(ip);
  }

  consumeProject(projectId: string): boolean {
    return this.#perProject.consume(projectId);
  }

  close(): void {
    this.#perIp.close();
    this.#perProject.close();
  }
}
