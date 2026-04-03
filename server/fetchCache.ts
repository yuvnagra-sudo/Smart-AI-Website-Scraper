/**
 * Shared Fetch Cache — Cross-Firm URL Deduplication
 *
 * When 50 concurrent workers process firms that link to shared pages
 * (e.g., partner sites, industry directories), this cache prevents
 * fetching the same URL multiple times.
 *
 * Design:
 *   - Global in-memory Map with 5-minute TTL
 *   - Stores Promise<result> so concurrent requests coalesce into one fetch
 *   - Cleared after each job completes
 */

interface CacheEntry {
  result: { content: string; links: string[]; rawHtml?: string } | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry | Promise<CacheEntry>>();

const TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get a cached fetch result, or null if not cached / expired.
 */
export function getCachedFetch(url: string): { content: string; links: string[]; rawHtml?: string } | null | undefined {
  const entry = cache.get(url);
  if (!entry || entry instanceof Promise) return undefined; // Not cached or in-flight
  if (Date.now() > entry.expiresAt) {
    cache.delete(url);
    return undefined; // Expired
  }
  return entry.result;
}

/**
 * Store a fetch result in the cache.
 */
export function setCachedFetch(url: string, result: { content: string; links: string[]; rawHtml?: string } | null): void {
  cache.set(url, {
    result,
    expiresAt: Date.now() + TTL_MS,
  });
}

/**
 * Execute a fetch with cache coalescing.
 * If the URL is already being fetched by another worker, waits for that result.
 * If not, executes the fetch and caches the result.
 */
export async function cachedFetch<T>(
  url: string,
  fetcher: () => Promise<T>,
): Promise<T> {
  // Check for cached result
  const existing = cache.get(url);
  if (existing && !(existing instanceof Promise)) {
    if (Date.now() <= existing.expiresAt) {
      return existing.result as T;
    }
    cache.delete(url);
  }

  // Check for in-flight request
  if (existing instanceof Promise) {
    const resolved = await existing;
    return resolved.result as T;
  }

  // Execute fetch and cache
  const promise = (async (): Promise<CacheEntry> => {
    const result = await fetcher();
    const entry: CacheEntry = { result: result as any, expiresAt: Date.now() + TTL_MS };
    cache.set(url, entry);
    return entry;
  })();

  cache.set(url, promise);

  try {
    const entry = await promise;
    return entry.result as T;
  } catch (err) {
    cache.delete(url); // Don't cache errors
    throw err;
  }
}

/**
 * Clear the entire cache (call after a job completes).
 */
export function clearFetchCache(): void {
  const size = cache.size;
  cache.clear();
  if (size > 0) {
    console.log(`[fetchCache] Cleared ${size} cached entries`);
  }
}

/**
 * Get cache statistics.
 */
export function getFetchCacheStats(): { size: number; entries: number } {
  // Count non-expired entries
  let entries = 0;
  const now = Date.now();
  for (const [, entry] of cache) {
    if (!(entry instanceof Promise) && entry.expiresAt > now) entries++;
  }
  return { size: cache.size, entries };
}
