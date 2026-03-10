/**
 * LLM Request Queue — Token Bucket + Concurrency Cap
 *
 * DESIGN GOALS:
 *   1. Never exceed the Gemini API RPM limit (causes 429 storms)
 *   2. Never have more than MAX_CONCURRENT requests in-flight simultaneously
 *   3. Retry 429s with exponential backoff + jitter
 *   4. Keep the dispatcher simple and predictable
 *
 * WHY THE PREVIOUS VERSION FAILED:
 *   The sliding-window dispatcher computed budget = RPM_LIMIT - windowUsed.
 *   On the very first tick, windowUsed = 0, so budget = 800.
 *   It immediately fired 800 requests in parallel, which saturated the API
 *   and caused every single call to return 429 RESOURCE_EXHAUSTED.
 *   The retry logic then made it worse by queuing even more retries.
 *
 * HOW THIS VERSION WORKS:
 *   - A token bucket refills at rate = RPM_LIMIT / 60 tokens per second.
 *   - Each dispatch consumes one token. If no tokens are available, the
 *     dispatcher sleeps until the next refill.
 *   - A hard MAX_CONCURRENT cap prevents more than N in-flight requests
 *     regardless of token availability.
 *   - 429 responses are retried with exponential backoff + jitter.
 *     The request is re-queued (not retried in a tight loop) so the
 *     dispatcher can continue processing other requests while waiting.
 *
 * CONFIGURATION (Railway env vars):
 *   LLM_RPM_LIMIT    — requests per minute (default: 60, safe for Tier 1)
 *   LLM_CONCURRENCY  — max simultaneous in-flight requests (default: 10)
 *
 * SAFE DEFAULTS:
 *   Gemini Tier 1 allows 15 RPM on gemini-3-flash-preview (free tier) or
 *   1000 RPM on paid Tier 1. Start conservative and increase if no 429s.
 *   Default is 60 RPM / 10 concurrent — works reliably on paid Tier 1.
 */

import { invokeLLM } from './openaiLLM';
import type { InvokeParams, InvokeResult } from './llm';

interface QueuedRequest {
  params: InvokeParams;
  resolve: (result: InvokeResult) => void;
  reject: (error: Error) => void;
  priority: number;
  enqueuedAt: number;
  attempt: number;          // retry attempt count
  retryAfter?: number;      // earliest timestamp to retry (for backoff)
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DEFAULT_RPM        = 60;   // conservative default — override with LLM_RPM_LIMIT
const DEFAULT_CONCURRENT = 10;   // max parallel in-flight — override with LLM_CONCURRENCY
const MAX_ATTEMPTS       = 6;    // total attempts before giving up (1 original + 5 retries)
const TICK_MS            = 200;  // dispatcher poll interval

// ---------------------------------------------------------------------------
// Queue implementation
// ---------------------------------------------------------------------------
export class LLMRequestQueue {
  private queue: QueuedRequest[] = [];
  private dispatcherRunning = false;

  // Token bucket state
  private tokens: number;
  private lastRefillTime: number = Date.now();
  private readonly tokensPerMs: number;   // refill rate
  private readonly maxTokens: number;     // bucket capacity = 1 second of requests

  // Concurrency
  private inFlight = 0;
  private readonly maxConcurrent: number;

  // Stats
  private totalProcessed = 0;
  private totalErrors    = 0;
  private totalRetries   = 0;

  constructor(requestsPerMinute = DEFAULT_RPM, maxConcurrent = DEFAULT_CONCURRENT) {
    this.maxConcurrent = maxConcurrent;
    this.tokensPerMs   = requestsPerMinute / 60_000;
    this.maxTokens     = Math.max(1, Math.floor(requestsPerMinute / 10)); // 6-second burst cap
    this.tokens        = this.maxTokens;

    console.log(
      `[LLM Queue] Initialized — ${requestsPerMinute} RPM, ` +
      `${maxConcurrent} max concurrent, ` +
      `burst cap: ${this.maxTokens} tokens`,
    );
  }

  /**
   * Enqueue an LLM request and return a Promise that resolves with the result.
   */
  async enqueue(params: InvokeParams, priority = 0): Promise<InvokeResult> {
    return new Promise((resolve, reject) => {
      this._push({ params, resolve, reject, priority, enqueuedAt: Date.now(), attempt: 0 });
    });
  }

  private _push(req: QueuedRequest) {
    this.queue.push(req);
    // Higher priority first; ties broken by FIFO
    this.queue.sort((a, b) =>
      a.priority !== b.priority ? b.priority - a.priority : a.enqueuedAt - b.enqueuedAt,
    );
    if (!this.dispatcherRunning) {
      this._runDispatcher();
    }
  }

  // ---------------------------------------------------------------------------
  // Dispatcher loop
  // ---------------------------------------------------------------------------
  private async _runDispatcher() {
    if (this.dispatcherRunning) return;
    this.dispatcherRunning = true;

    while (this.queue.length > 0 || this.inFlight > 0) {
      this._refillTokens();

      const now = Date.now();

      // Find the next request that is ready (past its retryAfter delay)
      const readyIdx = this.queue.findIndex(r => !r.retryAfter || r.retryAfter <= now);

      if (readyIdx === -1) {
        // All queued requests are in backoff — wait for the soonest one
        const soonest = Math.min(...this.queue.map(r => r.retryAfter ?? now));
        await sleep(Math.max(TICK_MS, soonest - now + 10));
        continue;
      }

      if (this.tokens < 1) {
        // Token bucket empty — wait for next refill
        const msUntilToken = Math.ceil((1 - this.tokens) / this.tokensPerMs);
        await sleep(Math.max(TICK_MS, msUntilToken));
        continue;
      }

      if (this.inFlight >= this.maxConcurrent) {
        // Concurrency cap reached — wait
        await sleep(TICK_MS);
        continue;
      }

      // Consume one token and dispatch
      this.tokens -= 1;
      this.inFlight++;
      const [req] = this.queue.splice(readyIdx, 1);

      const waitMs = now - req.enqueuedAt;
      if (waitMs > 3000 || req.attempt > 0) {
        console.log(
          `[LLM Queue] Dispatching (attempt ${req.attempt + 1}/${MAX_ATTEMPTS}, ` +
          `waited ${Math.ceil(waitMs / 1000)}s, ` +
          `queue: ${this.queue.length}, in-flight: ${this.inFlight}, ` +
          `tokens: ${this.tokens.toFixed(1)})`,
        );
      }

      this._executeRequest(req); // fire-and-forget
    }

    this.dispatcherRunning = false;
  }

  // ---------------------------------------------------------------------------
  // Token bucket refill
  // ---------------------------------------------------------------------------
  private _refillTokens() {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.tokensPerMs);
    this.lastRefillTime = now;
  }

  // ---------------------------------------------------------------------------
  // Execute a single request; re-queue on 429, reject on other errors
  // ---------------------------------------------------------------------------
  private async _executeRequest(req: QueuedRequest) {
    try {
      const result = await invokeLLM(req.params);
      this.inFlight--;
      this.totalProcessed++;
      req.resolve(result);
    } catch (err: any) {
      this.inFlight--;

      const is429 =
        err?.message?.includes('429') ||
        err?.message?.includes('RESOURCE_EXHAUSTED');

      if (is429 && req.attempt < MAX_ATTEMPTS - 1) {
        this.totalRetries++;
        // Exponential backoff: 2s, 4s, 8s, 16s, 32s + jitter
        const backoffMs = Math.min(60_000, Math.pow(2, req.attempt + 1) * 1000)
                        + Math.random() * 1000;
        console.warn(
          `[LLM Queue] 429 — re-queuing attempt ${req.attempt + 1}/${MAX_ATTEMPTS - 1} ` +
          `in ${Math.ceil(backoffMs / 1000)}s`,
        );
        // Re-queue with backoff delay and incremented attempt count
        req.attempt++;
        req.retryAfter = Date.now() + backoffMs;
        this._push(req);
        if (!this.dispatcherRunning) {
          this._runDispatcher();
        }
      } else {
        this.totalErrors++;
        const label = is429 ? 'LLM 429 — max retries exceeded' : 'LLM call failed';
        console.error(`[LLM Queue] ${label}: ${err?.message ?? 'unknown error'}`);
        req.reject(err instanceof Error ? err : new Error(err?.message ?? label));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------
  getStatistics() {
    return {
      queueDepth:     this.queue.length,
      inFlight:       this.inFlight,
      tokens:         Math.floor(this.tokens),
      rpmLimit:       Math.round(this.tokensPerMs * 60_000),
      maxConcurrent:  this.maxConcurrent,
      totalProcessed: this.totalProcessed,
      totalErrors:    this.totalErrors,
      totalRetries:   this.totalRetries,
      errorRate:
        this.totalProcessed > 0
          ? ((this.totalErrors / this.totalProcessed) * 100).toFixed(2) + '%'
          : '0%',
    };
  }

  clear() {
    const n = this.queue.length;
    this.queue.forEach(r => r.reject(new Error('Queue cleared')));
    this.queue = [];
    console.log(`[LLM Queue] Cleared ${n} pending requests (${this.inFlight} in-flight unchanged)`);
  }
}

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------
// SAFE DEFAULTS — override in Railway env vars:
//
//   LLM_RPM_LIMIT=60    → 1 request/second, well within Tier 1 paid quota
//   LLM_CONCURRENCY=10  → 10 parallel requests max
//
// Once you confirm no 429s, increase gradually:
//   LLM_RPM_LIMIT=120, LLM_CONCURRENCY=20   → 2× speed
//   LLM_RPM_LIMIT=300, LLM_CONCURRENCY=40   → 5× speed
//   LLM_RPM_LIMIT=600, LLM_CONCURRENCY=60   → 10× speed (near Tier 1 ceiling)
//
// gemini-3-flash-preview Tier 1 hard limit: 1,000 RPM
// Stay at ≤80% of the limit to avoid 429 bursts: max ~800 RPM
// ---------------------------------------------------------------------------
const configuredRpm         = parseInt(process.env.LLM_RPM_LIMIT    ?? '60',  10);
const configuredConcurrency = parseInt(process.env.LLM_CONCURRENCY  ?? '10',  10);

export const llmQueue = new LLMRequestQueue(configuredRpm, configuredConcurrency);

export async function queuedLLMCall(
  params: InvokeParams,
  priority = 0,
): Promise<InvokeResult> {
  return llmQueue.enqueue(params, priority);
}

export function getLLMQueueStats() {
  return llmQueue.getStatistics();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
