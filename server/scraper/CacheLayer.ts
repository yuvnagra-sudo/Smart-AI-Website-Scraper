/**
 * Cache Layer - In-memory caching with TTL
 */

import { CacheEntry } from "./types";

const MAX_CACHE_ENTRIES = 500; // ~100–200 MB cap at ~200–400 KB per entry

export class CacheLayer {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanupTask();
  }

  /**
   * Get cached value
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    const age = (now - entry.timestamp) / 1000; // seconds

    if (age > entry.ttl) {
      // Expired
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  /**
   * Set cached value
   */
  set<T>(key: string, data: T, ttl: number): void {
    // Evict oldest entry when at capacity (simple LRU-like behaviour using
    // Map insertion order — the first key is the oldest).
    if (this.cache.size >= MAX_CACHE_ENTRIES && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }

    const entry: CacheEntry<T> = {
      key,
      data,
      timestamp: Date.now(),
      ttl,
    };
    // Delete-then-set moves the key to the "newest" position in Map order.
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Delete cached value
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const now = Date.now();
    const entries = Array.from(this.cache.values());
    const expired = entries.filter((e) => (now - e.timestamp) / 1000 > e.ttl).length;

    return {
      total: this.cache.size,
      active: this.cache.size - expired,
      expired,
      memoryUsage: this.estimateMemoryUsage(),
    };
  }

  /**
   * Estimate memory usage (rough approximation)
   */
  private estimateMemoryUsage(): number {
    let bytes = 0;
    for (const entry of Array.from(this.cache.values())) {
      // Rough estimate: JSON string length * 2 (for UTF-16)
      bytes += JSON.stringify(entry.data).length * 2;
    }
    return bytes;
  }

  /**
   * Cleanup expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of Array.from(this.cache.entries())) {
      const age = (now - entry.timestamp) / 1000;
      if (age > entry.ttl) {
        this.cache.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[CacheLayer] Cleaned up ${removed} expired entries`);
    }
  }

  /**
   * Start periodic cleanup task
   */
  private startCleanupTask(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 5 * 60 * 1000); // Run every 5 minutes
  }

  /**
   * Stop cleanup task
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.clear();
  }
}

// Singleton instance
let cacheLayer: CacheLayer | null = null;

export function getCacheLayer(): CacheLayer {
  if (!cacheLayer) {
    cacheLayer = new CacheLayer();
  }
  return cacheLayer;
}

export function destroyCacheLayer(): void {
  if (cacheLayer) {
    cacheLayer.destroy();
    cacheLayer = null;
  }
}
