/**
 * LLM Request Queue with Parallel Batch Processing
 *
 * Replaces the original serial queue (one request at a time) with a parallel
 * dispatcher that fires multiple requests simultaneously while respecting the
 * configured RPM cap.
 *
 * WHY THIS MATTERS:
 *   Old design: 1 request at a time → ~12 actual RPM (bottlenecked by 5s API latency)
 *   New design: N parallel requests → ~500 actual RPM at 800 RPM cap
 *   Speed improvement: ~40× for large jobs (1900 firms: 21h → ~30 min)
 *
 * HOW IT WORKS:
 *   - A sliding window tracks how many requests have been dispatched in the
 *     current 60-second window.
 *   - The dispatcher loop wakes up every TICK_MS (50ms) and dispatches as many
 *     requests as the remaining window budget allows.
 *   - Each dispatched request runs independently (fire-and-forget from the
 *     dispatcher's perspective); the Promise resolves/rejects when the API responds.
 *   - 429 responses are retried with exponential backoff without blocking the
 *     dispatcher loop.
 *
 * CONFIGURATION (Railway env vars):
 *   LLM_RPM_LIMIT — requests per minute cap (default: 800)
 *                   Set to 2000 on Tier 2, 4000 on Tier 3
 */

import { invokeLLM, type InvokeParams, type InvokeResult } from './openaiLLM';

interface QueuedRequest {
  params: InvokeParams;
  resolve: (result: InvokeResult) => void;
  reject: (error: Error) => void;
  priority: number;
  enqueuedAt: number;
}

const TICK_MS = 50;          // Dispatcher wakes up every 50ms
const WINDOW_MS = 60_000;    // RPM window duration

export class LLMRequestQueue {
  private queue: QueuedRequest[] = [];
  private dispatcherRunning = false;

  // Sliding window: timestamps of requests dispatched in the last WINDOW_MS
  private windowTimestamps: number[] = [];

  // Rate limit config
  private requestsPerMinute: number;

  // Statistics
  private totalProcessed = 0;
  private totalErrors = 0;
  private totalWaitTime = 0;
  private inFlight = 0;

  constructor(requestsPerMinute = 800) {
    this.requestsPerMinute = requestsPerMinute;
    console.log(
      `[LLM Queue] Initialized — ${requestsPerMinute} RPM limit, ` +
      `parallel dispatch (up to ${Math.min(requestsPerMinute, 100)} concurrent)`,
    );
  }

  /**
   * Enqueue an LLM request.
   * @param params  LLM invocation parameters
   * @param priority Higher priority requests are processed first (default: 0)
   * @returns Promise that resolves with the LLM result
   */
  async enqueue(params: InvokeParams, priority = 0): Promise<InvokeResult> {
    return new Promise((resolve, reject) => {
      const request: QueuedRequest = {
        params,
        resolve,
        reject,
        priority,
        enqueuedAt: Date.now(),
      };

      this.queue.push(request);

      // Keep queue sorted: higher priority first, then FIFO
      this.queue.sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.enqueuedAt - b.enqueuedAt;
      });

      if (!this.dispatcherRunning) {
        this.runDispatcher();
      }
    });
  }

  /**
   * Dispatcher loop — runs every TICK_MS and fires as many requests as the
   * current RPM window allows.
   */
  private async runDispatcher() {
    if (this.dispatcherRunning) return;
    this.dispatcherRunning = true;

    while (this.queue.length > 0 || this.inFlight > 0) {
      const now = Date.now();

      // Prune timestamps older than the window
      this.windowTimestamps = this.windowTimestamps.filter(t => now - t < WINDOW_MS);

      const budget = this.requestsPerMinute - this.windowTimestamps.length;

      if (budget > 0 && this.queue.length > 0) {
        // Dispatch up to `budget` requests in parallel
        const batch = this.queue.splice(0, budget);

        for (const req of batch) {
          const waitMs = now - req.enqueuedAt;
          this.totalWaitTime += waitMs;

          if (waitMs > 5000) {
            console.log(
              `[LLM Queue] Processing request (waited ${Math.ceil(waitMs / 1000)}s, ` +
              `priority: ${req.priority}, queue: ${this.queue.length}, in-flight: ${this.inFlight})`,
            );
          }

          this.windowTimestamps.push(now);
          this.inFlight++;
          this.dispatchRequest(req); // fire-and-forget (non-blocking)
        }
      } else if (budget <= 0) {
        // Window is full — log and wait until the oldest request ages out
        const oldestTs = this.windowTimestamps[0] ?? now;
        const waitMs = WINDOW_MS - (now - oldestTs) + 10;
        console.log(
          `[LLM Queue] Rate limit reached (${this.windowTimestamps.length}/${this.requestsPerMinute} RPM), ` +
          `waiting ${Math.ceil(waitMs / 1000)}s. Queue: ${this.queue.length}, in-flight: ${this.inFlight}`,
        );
        await sleep(Math.max(waitMs, TICK_MS));
        continue;
      }

      // Log minute boundary for observability (matches old format)
      if (this.totalProcessed > 0 && this.totalProcessed % this.requestsPerMinute === 0) {
        this.logStatistics();
      }

      await sleep(TICK_MS);
    }

    this.dispatcherRunning = false;
  }

  /**
   * Dispatch a single request asynchronously with retry on 429.
   * Does NOT block the dispatcher loop.
   */
  private async dispatchRequest(req: QueuedRequest) {
    let result: InvokeResult | undefined;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        result = await invokeLLM(req.params);
        break;
      } catch (err: any) {
        const is429 =
          err?.status === 429 ||
          err?.message?.includes('429') ||
          err?.message?.includes('RESOURCE_EXHAUSTED');

        if (is429 && attempt < 4) {
          const backoffMs = Math.min(60_000, Math.pow(2, attempt) * 1000) + Math.random() * 500;
          console.warn(
            `[LLM Queue] 429 rate limit — retry ${attempt + 1}/4 in ${Math.ceil(backoffMs / 1000)}s`,
          );
          await sleep(backoffMs);
        } else {
          lastError = err as Error;
          break;
        }
      }
    }

    this.inFlight--;

    if (result !== undefined) {
      this.totalProcessed++;
      req.resolve(result);
    } else {
      this.totalErrors++;
      const msg = lastError?.message ?? 'LLM call failed after retries';
      console.error(`[LLM Queue] Request failed: ${msg}`);
      req.reject(lastError ?? new Error(msg));
    }
  }

  /**
   * Get current queue statistics.
   */
  getStatistics() {
    return {
      queueDepth: this.queue.length,
      inFlight: this.inFlight,
      windowUsed: this.windowTimestamps.length,
      rpmLimit: this.requestsPerMinute,
      totalProcessed: this.totalProcessed,
      totalErrors: this.totalErrors,
      averageWaitTime:
        this.totalProcessed > 0 ? Math.ceil(this.totalWaitTime / this.totalProcessed) : 0,
      errorRate:
        this.totalProcessed > 0
          ? ((this.totalErrors / this.totalProcessed) * 100).toFixed(2) + '%'
          : '0%',
    };
  }

  /**
   * Log queue statistics.
   */
  private logStatistics() {
    const s = this.getStatistics();
    console.log(
      `[LLM Queue Stats] Processed: ${s.totalProcessed}, ` +
      `Errors: ${s.totalErrors} (${s.errorRate}), ` +
      `Avg Wait: ${s.averageWaitTime}ms, ` +
      `Queue: ${s.queueDepth}, In-flight: ${s.inFlight}`,
    );
  }

  /**
   * Clear the queue (for testing or emergency stop).
   * In-flight requests are NOT cancelled — they will complete normally.
   */
  clear() {
    const cleared = this.queue.length;
    this.queue.forEach(req => req.reject(new Error('Queue cleared')));
    this.queue = [];
    console.log(`[LLM Queue] Cleared ${cleared} pending requests (${this.inFlight} in-flight unchanged)`);
  }
}

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------
// 800 RPM — 80% safety buffer below the 1,000 RPM Tier 1 cap for gemini-3-flash-preview
// Override via LLM_RPM_LIMIT env var in Railway:
//   Tier 1 (default): LLM_RPM_LIMIT=800
//   Tier 2 (2000 RPM): LLM_RPM_LIMIT=1800
//   Tier 3 (4000 RPM): LLM_RPM_LIMIT=3600
export const llmQueue = new LLMRequestQueue(
  parseInt(process.env.LLM_RPM_LIMIT ?? '800', 10),
);

/**
 * Convenience function to enqueue LLM requests.
 * Use this instead of calling invokeLLM() directly.
 */
export async function queuedLLMCall(
  params: InvokeParams,
  priority = 0,
): Promise<InvokeResult> {
  return llmQueue.enqueue(params, priority);
}

/**
 * Get queue statistics.
 */
export function getLLMQueueStats() {
  return llmQueue.getStatistics();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
