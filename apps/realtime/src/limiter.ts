/**
 * A bounded count of in-flight handshake lookups (T-0160 review). Each
 * well-formed Bearer costs a database round trip on a small pool, so without a
 * cap a flood of random tokens would queue ahead of the revalidation sweep.
 * Beyond the cap the caller refuses with 503 and never touches the database.
 */
export class InFlightLimiter {
  private active = 0;

  constructor(private readonly max: number) {}

  /** Runs `task` if a slot is free; `null` (task not called) when the cap is reached. */
  async run<T>(task: () => Promise<T>): Promise<{ readonly value: T } | null> {
    if (this.active >= this.max) return null;
    this.active += 1;
    try {
      return { value: await task() };
    } finally {
      this.active -= 1;
    }
  }
}
