export class ConcurrencyGate {
  private active = 0;

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('Concurrency gate capacity must be a positive safe integer');
    }
  }

  tryAcquire(): boolean {
    if (this.active >= this.capacity) {
      return false;
    }
    this.active += 1;
    return true;
  }

  release(): void {
    if (this.active === 0) {
      throw new Error('Cannot release a concurrency gate with no in-flight work');
    }
    this.active -= 1;
  }

  get inFlight(): number {
    return this.active;
  }
}
