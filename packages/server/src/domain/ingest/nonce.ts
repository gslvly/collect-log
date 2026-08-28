import { configuredLimits } from '../../config/limits.js';

interface NonceEntry {
  expiresAt: number;
}

export class NonceCache {
  readonly #entries = new Map<string, NonceEntry>();
  readonly #cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly capacity = configuredLimits.ingest.nonceCacheSize,
    private readonly ttlMs = configuredLimits.ingest.signatureWindowMs,
    private readonly now: () => number = Date.now,
  ) {
    this.#cleanupTimer = setInterval(() => this.cleanupExpired(), Math.min(ttlMs, 60_000));
    this.#cleanupTimer.unref();
  }

  consume(projectId: string, nonce: string): boolean {
    const key = `${projectId}:${nonce}`;
    const now = this.now();
    const existing = this.#entries.get(key);

    if (existing !== undefined && existing.expiresAt > now) {
      this.#entries.delete(key);
      this.#entries.set(key, existing);
      return false;
    }
    if (existing !== undefined) {
      this.#entries.delete(key);
    }

    while (this.#entries.size >= this.capacity) {
      const leastRecentlyUsed = this.#entries.keys().next().value;
      if (leastRecentlyUsed === undefined) {
        break;
      }
      this.#entries.delete(leastRecentlyUsed);
    }
    this.#entries.set(key, { expiresAt: now + this.ttlMs });
    return true;
  }

  close(): void {
    clearInterval(this.#cleanupTimer);
    this.#entries.clear();
  }

  private cleanupExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
      }
    }
  }
}
