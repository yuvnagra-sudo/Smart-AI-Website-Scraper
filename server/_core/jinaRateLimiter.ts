/**
 * Global Jina API Rate Limiter — Token Bucket
 *
 * Ensures Jina Reader API calls stay within the plan RPM limit (default 450,
 * configurable via JINA_RPM_LIMIT env var). All calls to fetchViaJina() must
 * acquire a token before firing.
 *
 * Uses a token-bucket algorithm: tokens refill at a steady rate (maxRPM / 60
 * tokens per second) up to a burst capacity. When the bucket is empty,
 * callers wait until a token becomes available.
 */

class JinaRateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRatePerMs: number; // tokens per millisecond
  private lastRefill: number;
  private readonly waitQueue: Array<{ resolve: () => void }> = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(maxRpm: number = 450) {
    // Burst capacity: allow up to 1/4 of per-minute budget as instant burst
    this.maxTokens = Math.max(1, Math.floor(maxRpm / 4));
    this.tokens = this.maxTokens;
    this.refillRatePerMs = maxRpm / 60_000; // e.g. 450 RPM → 0.0075 tokens/ms
    this.lastRefill = Date.now();
  }

  /** Refill tokens based on elapsed time since last refill. */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;

    const newTokens = elapsed * this.refillRatePerMs;
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }

  /** Drain the wait queue as tokens become available. */
  private scheduleDrain(): void {
    if (this.drainTimer || this.waitQueue.length === 0) return;

    // Time until next token is available
    const msPerToken = 1 / this.refillRatePerMs;
    const waitMs = Math.max(10, Math.ceil(msPerToken - this.tokens * msPerToken));

    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.refill();

      // Release as many waiters as we have tokens
      while (this.waitQueue.length > 0 && this.tokens >= 1) {
        this.tokens -= 1;
        const waiter = this.waitQueue.shift()!;
        waiter.resolve();
      }

      // If still waiting, schedule again
      if (this.waitQueue.length > 0) {
        this.scheduleDrain();
      }
    }, waitMs);
  }

  /**
   * Acquire a token. Resolves immediately if a token is available,
   * otherwise waits until one is refilled.
   */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // No token available — queue and wait
    const waitMs = Math.ceil(1 / this.refillRatePerMs);
    if (this.waitQueue.length === 0) {
      console.log(`[Jina Rate Limiter] Throttling — waiting ~${waitMs}ms for next token`);
    }

    return new Promise<void>((resolve) => {
      this.waitQueue.push({ resolve });
      this.scheduleDrain();
    });
  }
}

export const jinaLimiter = new JinaRateLimiter(
  parseInt(process.env.JINA_RPM_LIMIT ?? "450", 10),
);
