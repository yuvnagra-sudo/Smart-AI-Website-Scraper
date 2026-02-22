/**
 * Request Manager - Rate limiting, retries, and circuit breaker
 */

import { RateLimitConfig, CircuitBreakerState } from "./types";

export class RequestManager {
  private requestQueues: Map<string, number[]> = new Map(); // domain -> timestamps
  private circuitBreakers: Map<string, CircuitBreakerState> = new Map(); // URL -> state (changed from domain)
  private rateLimitConfig: RateLimitConfig;

  constructor(config?: Partial<RateLimitConfig>) {
    this.rateLimitConfig = {
      requestsPerSecond: config?.requestsPerSecond || 2,
      burstSize: config?.burstSize || 5,
      retryAfter: config?.retryAfter || 30, // Reduced from 60s for faster recovery
    };
  }

  /**
   * Wait if rate limit would be exceeded
   */
  async waitForRateLimit(domain: string): Promise<void> {
    const now = Date.now();
    const queue = this.requestQueues.get(domain) || [];
    
    // Remove timestamps older than 1 second
    const recentRequests = queue.filter((timestamp) => now - timestamp < 1000);
    
    // Check if we're at the limit
    if (recentRequests.length >= this.rateLimitConfig.requestsPerSecond) {
      const oldestRequest = Math.min(...recentRequests);
      const waitTime = 1000 - (now - oldestRequest) + 100; // Add 100ms buffer
      
      if (waitTime > 0) {
        console.log(`[RequestManager] Rate limit reached for ${domain}, waiting ${waitTime}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }
    
    // Add current request to queue
    recentRequests.push(Date.now());
    this.requestQueues.set(domain, recentRequests);
  }

  /**
   * Check if circuit breaker is open for a URL
   */
  isCircuitOpen(url: string): boolean {
    const breaker = this.circuitBreakers.get(url);
    if (!breaker) return false;

    const now = Date.now();

    // Check if circuit should transition to half-open
    if (breaker.state === "open" && now >= breaker.nextAttemptTime) {
      breaker.state = "half-open";
      this.circuitBreakers.set(url, breaker);
      console.log(`[RequestManager] Circuit breaker for ${url} transitioned to half-open`);
      return false;
    }

    return breaker.state === "open";
  }

  /**
   * Record a successful request
   */
  recordSuccess(url: string): void {
    const breaker = this.circuitBreakers.get(url);
    if (breaker) {
      if (breaker.state === "half-open") {
        // Success in half-open state, close the circuit
        breaker.state = "closed";
        breaker.failures = 0;
        console.log(`[RequestManager] Circuit breaker for ${url} closed after successful request`);
      } else {
        // Reset failure count on success
        breaker.failures = 0;
      }
      this.circuitBreakers.set(url, breaker);
    }
  }

  /**
   * Record a failed request
   */
  recordFailure(url: string): void {
    const now = Date.now();
    let breaker = this.circuitBreakers.get(url);

    if (!breaker) {
      breaker = {
        failures: 0,
        lastFailureTime: now,
        state: "closed",
        nextAttemptTime: 0,
      };
    }

    breaker.failures++;
    breaker.lastFailureTime = now;

    // Open circuit if too many failures
    // Increased from 10 to 20 for OpenAI-only fast processing (Phase 2 optimization)
    // Fast processing (49 firms/min) needs higher tolerance to avoid false positives
    if (breaker.failures >= 20) {
      breaker.state = "open";
      breaker.nextAttemptTime = now + this.rateLimitConfig.retryAfter * 1000;
      console.log(
        `[RequestManager] Circuit breaker for ${url} opened after ${breaker.failures} failures. Will retry at ${new Date(breaker.nextAttemptTime).toISOString()}`
      );
    }

    this.circuitBreakers.set(url, breaker);
  }

  /**
   * Execute a request with retries
   */
  async executeWithRetry<T>(
    fn: () => Promise<T>,
    domain: string,
    url: string, // For per-URL circuit breaker tracking
    maxRetries = 3
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Check circuit breaker (per-URL)
      if (this.isCircuitOpen(url)) {
        throw new Error(`Circuit breaker open for ${url}`);
      }

      // Wait for rate limit
      await this.waitForRateLimit(domain);

      try {
        const result = await fn();
        this.recordSuccess(url); // Record success for this specific URL
        return result;
      } catch (error) {
        lastError = error as Error;
        this.recordFailure(url); // Record failure for this specific URL

        if (attempt < maxRetries - 1) {
          const backoffTime = Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s
          console.log(
            `[RequestManager] Attempt ${attempt + 1}/${maxRetries} failed for ${domain}, retrying in ${backoffTime}ms`
          );
          await new Promise((resolve) => setTimeout(resolve, backoffTime));
        }
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  /**
   * Get statistics for a domain
   */
  getStats(domain: string) {
    const breaker = this.circuitBreakers.get(domain);
    const queue = this.requestQueues.get(domain) || [];
    const now = Date.now();
    const recentRequests = queue.filter((timestamp) => now - timestamp < 1000);

    return {
      domain,
      circuitState: breaker?.state || "closed",
      failures: breaker?.failures || 0,
      recentRequests: recentRequests.length,
      rateLimitConfig: this.rateLimitConfig,
    };
  }

  /**
   * Reset circuit breaker for a domain
   */
  resetCircuitBreaker(domain: string): void {
    this.circuitBreakers.delete(domain);
    console.log(`[RequestManager] Reset circuit breaker for ${domain}`);
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.requestQueues.clear();
    this.circuitBreakers.clear();
  }
}

// Singleton instance
let requestManager: RequestManager | null = null;

export function getRequestManager(): RequestManager {
  if (!requestManager) {
    requestManager = new RequestManager();
  }
  return requestManager;
}
