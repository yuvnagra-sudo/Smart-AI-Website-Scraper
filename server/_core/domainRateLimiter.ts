/**
 * Per-domain rate limiter
 *
 * Ensures at most 1 concurrent request per domain with a minimum gap
 * between requests to avoid triggering bot detection or rate limits.
 *
 * Usage:
 *   const result = await withDomainRateLimit(url, () => fetchSomething(url));
 */

const domainQueues = new Map<string, Promise<void>>();

/**
 * Extracts the registered domain from a URL (e.g. "sub.example.com" → "example.com").
 * Falls back to the full hostname if parsing fails.
 */
function getDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    const parts = hostname.split(".");
    // Use last two segments as the domain key (covers sub.example.com → example.com)
    return parts.length >= 2 ? parts.slice(-2).join(".") : hostname;
  } catch {
    return url;
  }
}

/**
 * Serialises requests to the same domain: waits for any in-flight request
 * to finish + a minimum gap before starting the next one.
 *
 * @param url         Target URL (used to extract domain)
 * @param fn          Async function to execute
 * @param minGapMs    Minimum delay between consecutive requests to the same domain (default 1500ms)
 */
export async function withDomainRateLimit<T>(
  url: string,
  fn: () => Promise<T>,
  minGapMs = 1500,
): Promise<T> {
  const domain = getDomain(url);

  const prev = domainQueues.get(domain) ?? Promise.resolve();
  let resolveGate!: () => void;
  const gate = new Promise<void>(r => { resolveGate = r; });

  // Chain: wait for previous request + gap, then release gate
  const next = prev
    .then(() => new Promise<void>(r => setTimeout(r, minGapMs)))
    .then(() => resolveGate());

  domainQueues.set(domain, next.then(() => gate).catch(() => {}));

  // Wait until it is our turn
  await next;

  try {
    return await fn();
  } finally {
    resolveGate(); // release the gate so the next request can start its gap timer
  }
}
