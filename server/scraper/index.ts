/**
 * Comprehensive Web Scraper - Main Export
 * 
 * Usage:
 * ```typescript
 * import { scrapeWebsite } from "./scraper";
 * 
 * const result = await scrapeWebsite({
 *   url: "https://example.com/team",
 *   cache: true,
 *   cacheTTL: 30 * 24 * 60 * 60, // 30 days
 * });
 * 
 * if (result.success) {
 *   console.log(result.html);
 * }
 * ```
 */

export { ComprehensiveScraper, getScraper } from "./ComprehensiveScraper";
export { BrowserPool, getBrowserPool, destroyBrowserPool } from "./BrowserPool";
export { RequestManager, getRequestManager } from "./RequestManager";
export { CacheLayer, getCacheLayer, destroyCacheLayer } from "./CacheLayer";
export * from "./types";

import { getScraper } from "./ComprehensiveScraper";
import type { ScrapingOptions, ScrapingResult } from "./types";

/**
 * Convenience function to scrape a website
 */
export async function scrapeWebsite(options: ScrapingOptions): Promise<ScrapingResult> {
  const scraper = getScraper();
  return scraper.scrape(options);
}

/**
 * Get scraping statistics
 */
export function getScrapingStats() {
  const scraper = getScraper();
  return scraper.getStats();
}
