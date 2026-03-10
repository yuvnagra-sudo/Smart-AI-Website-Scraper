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
 *   LLM_RPM_LIMIT    — requests per minute (default: 8000 for OpenAI Tier 4)
 *   LLM_CONCURRENCY  — max simultaneous in-flight requests (default: 200)
 *
 * TIER REFERENCE (gpt-5-mini, source: platform.openai.com/docs/models/gpt-5-mini):
 *   Tier 1:  500 RPM  /   500K TPM
 *   Tier 2:  5,000 RPM /  2M TPM
 *   Tier 3:  5,000 RPM /  4M TPM
 *   Tier 4: 10,000 RPM / 10M TPM  ← current tier
 *   Tier 5: 30,000 RPM / 180M TPM
 *
 * Default is 8,000 RPM (80% of Tier 4 hard limit) / 200 concurrent.
 * The 80% buffer prevents 429s from burst variance while maximising throughput.
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
const DEFAULT_RPM        = 8_000; // 80% of OpenAI Tier 4 limit (10,000 RPM for gpt-5-mini)
const DEFAULT_CONCURRENT = 200;   // 200 parallel in-flight — tuned for Tier 4 throughput
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
    // Guard against NaN/0 from bad env var parsing — fall back to safe defaults
    const safeRpm      = (Number.isFinite(requestsPerMinute) && requestsPerMinute > 0)
                           ? requestsPerMinute
                           : DEFAULT_RPM;
    const safeConcurrent = (Number.isFinite(maxConcurrent) && maxConcurrent > 0)
                           ? maxConcurrent
                           : DEFAULT_CONCURRENT;

    this.maxConcurrent = safeConcurrent;
    this.tokensPerMs   = safeRpm / 60_000;                         // always > 0
    this.maxTokens     = Math.max(1, Math.floor(safeRpm / 10));    // 6-second burst cap
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
        const waitMs  = soonest - now + 10;
        // Clamp to prevent Infinity/NaN from reaching setTimeout
        await sleep(Math.max(TICK_MS, Math.min(30_000, Number.isFinite(waitMs) ? waitMs : TICK_MS)));
        continue;
      }

      if (this.tokens < 1) {
        // Token bucket empty — wait for next refill
        // Guard: tokensPerMs is always > 0 after constructor validation, but
        // clamp the result to MAX_SAFE_TIMEOUT to prevent TimeoutOverflowWarning.
        const MAX_SAFE_TIMEOUT = 30_000; // 30 seconds max sleep
        const msUntilToken = Math.min(
          MAX_SAFE_TIMEOUT,
          Math.ceil((1 - this.tokens) / this.tokensPerMs),
        );
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
// Defaults are tuned for OpenAI Tier 4 (gpt-5-mini).
// Override in Railway env vars if on a different tier:
//
//   Tier 1:  LLM_RPM_LIMIT=400,  LLM_CONCURRENCY=20
//   Tier 2:  LLM_RPM_LIMIT=4000, LLM_CONCURRENCY=80
//   Tier 3:  LLM_RPM_LIMIT=4000, LLM_CONCURRENCY=80
//   Tier 4:  LLM_RPM_LIMIT=8000, LLM_CONCURRENCY=200  ← default
//   Tier 5:  LLM_RPM_LIMIT=24000,LLM_CONCURRENCY=500
//
// For Gemini (primary provider), override with your Gemini RPM cap:
//   gemini-3-flash-preview Tier 1: LLM_RPM_LIMIT=800, LLM_CONCURRENCY=60
//
// Throughput at Tier 4 defaults (8,000 RPM / 200 concurrent):
//   1,900-firm job = ~15,200 LLM calls → completes in ~2 minutes
// ---------------------------------------------------------------------------
const configuredRpm         = parseInt(process.env.LLM_RPM_LIMIT    ?? '8000', 10);
const configuredConcurrency = parseInt(process.env.LLM_CONCURRENCY  ?? '200',  10);

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
