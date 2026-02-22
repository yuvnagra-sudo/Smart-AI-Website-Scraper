/**
 * LLM Request Queue with Rate Limiting
 * 
 * Prevents rate limit errors by queuing requests and enforcing a maximum
 * requests-per-minute limit. Supports priority queuing for critical requests.
 */

import { invokeLLM, type InvokeParams, type InvokeResult } from './llm';

interface QueuedRequest {
  params: InvokeParams;
  resolve: (result: InvokeResult) => void;
  reject: (error: Error) => void;
  priority: number;
  enqueuedAt: number;
}

export class LLMRequestQueue {
  private queue: QueuedRequest[] = [];
  private processing = false;
  
  // Rate limiting configuration
  private requestsPerMinute: number;
  private requestsThisMinute = 0;
  private minuteStartTime = Date.now();
  
  // Statistics
  private totalProcessed = 0;
  private totalErrors = 0;
  private totalWaitTime = 0;
  
  constructor(requestsPerMinute = 50) {
    this.requestsPerMinute = requestsPerMinute;
    console.log(`[LLM Queue] Initialized with ${requestsPerMinute} RPM limit`);
  }
  
  /**
   * Enqueue an LLM request
   * @param params LLM invocation parameters
   * @param priority Higher priority requests are processed first (default: 0)
   * @returns Promise that resolves with LLM result
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
      
      // Sort by priority (higher first), then by enqueue time (FIFO)
      this.queue.sort((a, b) => {
        if (a.priority !== b.priority) {
          return b.priority - a.priority; // Higher priority first
        }
        return a.enqueuedAt - b.enqueuedAt; // Earlier requests first
      });
      
      // Start processing if not already running
      if (!this.processing) {
        this.processQueue();
      }
    });
  }
  
  /**
   * Process queued requests while respecting rate limits
   */
  private async processQueue() {
    if (this.processing) return;
    this.processing = true;
    
    while (this.queue.length > 0) {
      // Reset counter every minute
      const now = Date.now();
      if (now - this.minuteStartTime >= 60000) {
        console.log(`[LLM Queue] Minute reset - Processed ${this.requestsThisMinute} requests`);
        this.requestsThisMinute = 0;
        this.minuteStartTime = now;
      }
      
      // Check if we've hit the rate limit
      if (this.requestsThisMinute >= this.requestsPerMinute) {
        const waitTime = 60000 - (now - this.minuteStartTime);
        console.log(
          `[LLM Queue] Rate limit reached (${this.requestsThisMinute}/${this.requestsPerMinute}), ` +
          `waiting ${Math.ceil(waitTime / 1000)}s. Queue depth: ${this.queue.length}`
        );
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      // Get next request
      const request = this.queue.shift();
      if (!request) break;
      
      const waitTime = Date.now() - request.enqueuedAt;
      this.totalWaitTime += waitTime;
      
      if (waitTime > 5000) {
        console.log(
          `[LLM Queue] Processing request (waited ${Math.ceil(waitTime / 1000)}s, ` +
          `priority: ${request.priority}, queue: ${this.queue.length})`
        );
      }
      
      this.requestsThisMinute++;
      
      try {
        const result = await invokeLLM(request.params);
        this.totalProcessed++;
        request.resolve(result);
      } catch (error) {
        this.totalErrors++;
        console.error(`[LLM Queue] Request failed:`, error);
        request.reject(error as Error);
      }
      
      // Small delay between requests to avoid bursts (100ms = 600 RPM max)
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    this.processing = false;
    
    if (this.totalProcessed > 0 && this.totalProcessed % 100 === 0) {
      this.logStatistics();
    }
  }
  
  /**
   * Get current queue statistics
   */
  getStatistics() {
    return {
      queueDepth: this.queue.length,
      requestsThisMinute: this.requestsThisMinute,
      totalProcessed: this.totalProcessed,
      totalErrors: this.totalErrors,
      averageWaitTime: this.totalProcessed > 0 
        ? Math.ceil(this.totalWaitTime / this.totalProcessed) 
        : 0,
      errorRate: this.totalProcessed > 0
        ? (this.totalErrors / this.totalProcessed * 100).toFixed(2) + '%'
        : '0%',
    };
  }
  
  /**
   * Log queue statistics
   */
  private logStatistics() {
    const stats = this.getStatistics();
    console.log(
      `[LLM Queue Stats] Processed: ${stats.totalProcessed}, ` +
      `Errors: ${stats.totalErrors} (${stats.errorRate}), ` +
      `Avg Wait: ${stats.averageWaitTime}ms, ` +
      `Queue: ${stats.queueDepth}`
    );
  }
  
  /**
   * Clear the queue (for testing or emergency stop)
   */
  clear() {
    const cleared = this.queue.length;
    this.queue.forEach(req => req.reject(new Error('Queue cleared')));
    this.queue = [];
    console.log(`[LLM Queue] Cleared ${cleared} pending requests`);
  }
}

// Global singleton instance
// Reduced to 20 RPM to stay well below account limits and avoid 412 errors
export const llmQueue = new LLMRequestQueue(20);

/**
 * Convenience function to enqueue LLM requests
 * Use this instead of calling invokeLLM() directly
 */
export async function queuedLLMCall(
  params: InvokeParams,
  priority = 0
): Promise<InvokeResult> {
  return llmQueue.enqueue(params, priority);
}

/**
 * Get queue statistics
 */
export function getLLMQueueStats() {
  return llmQueue.getStatistics();
}
