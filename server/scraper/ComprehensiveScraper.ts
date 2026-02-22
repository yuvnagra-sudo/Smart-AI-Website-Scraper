/**
 * Comprehensive Web Scraper
 * Multi-strategy scraping with intelligent fallbacks
 */

import axios from "axios";
import * as cheerio from "cheerio";
import { getBrowserPool } from "./BrowserPool";
import { getRequestManager } from "./RequestManager";
import { getCacheLayer } from "./CacheLayer";
import {
  ScrapingOptions,
  ScrapingResult,
  ScrapingStrategy,
  ScrapingMetrics,
} from "./types";

export class ComprehensiveScraper {
  private browserPool = getBrowserPool();
  private requestManager = getRequestManager();
  private cache = getCacheLayer();
  private metrics: ScrapingMetrics[] = [];

  /**
   * Scrape a URL using the best available strategy
   */
  async scrape(options: ScrapingOptions): Promise<ScrapingResult> {
    const startTime = Date.now();
    const domain = new URL(options.url).hostname;

    // Check cache first
    if (options.cache !== false) {
      const cacheKey = this.getCacheKey(options);
      const cached = this.cache.get<ScrapingResult>(cacheKey);
      if (cached) {
        console.log(`[Scraper] Cache hit for ${options.url}`);
        return { ...cached, cached: true };
      }
    }

    // Try strategies in order: Static (fast) -> API Detection -> Browser (slow fallback)
    const strategies = [
      { name: ScrapingStrategy.STATIC_HTML, fn: () => this.scrapeStatic(options) },
      // Only use browser for team/people/about pages that likely need JS rendering
      ...(options.url.includes('/team') || options.url.includes('/people') || options.url.includes('/about')
        ? [
            { name: ScrapingStrategy.HEADLESS_BROWSER, fn: () => this.scrapeBrowser(options, false) },
          ]
        : []),
    ];

    let lastError: Error | undefined;

    for (const strategy of strategies) {
      try {
        console.log(`[Scraper] Trying ${strategy.name} for ${options.url}`);
        
        const result = await this.requestManager.executeWithRetry(
          strategy.fn,
          domain,
          options.url, // URL for circuit breaker tracking
          1 // No retries within strategy, we'll try next strategy instead
        );

        result.strategy = strategy.name;
        result.duration = Date.now() - startTime;
        result.cached = false;

        // Cache successful result
        if (result.success && options.cache !== false) {
          const cacheKey = this.getCacheKey(options);
          const ttl = options.cacheTTL || 30 * 24 * 60 * 60; // 30 days default
          this.cache.set(cacheKey, result, ttl);
        }

        // Record metrics
        this.recordMetrics({
          strategy: strategy.name,
          duration: result.duration,
          success: result.success,
          cached: false,
          retryCount: 0,
          timestamp: Date.now(),
        });

        return result;
      } catch (error) {
        lastError = error as Error;
        console.log(`[Scraper] ${strategy.name} failed for ${options.url}:`, error);
        continue;
      }
    }

    // All strategies failed
    const duration = Date.now() - startTime;
    this.recordMetrics({
      strategy: ScrapingStrategy.STATIC_HTML,
      duration,
      success: false,
      cached: false,
      retryCount: 0,
      error: lastError?.message,
      timestamp: Date.now(),
    });

    return {
      success: false,
      strategy: ScrapingStrategy.STATIC_HTML,
      duration,
      cached: false,
      error: lastError?.message || "All scraping strategies failed",
    };
  }

  /**
   * Strategy 1: Static HTML scraping (fastest)
   */
  private async scrapeStatic(options: ScrapingOptions): Promise<ScrapingResult> {
    const response = await axios.get(options.url, {
      headers: {
        "User-Agent":
          options.userAgent ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        ...options.headers,
      },
      timeout: options.timeout || 5000, // Reduced from 10s to 5s
      maxRedirects: 5,
    });

    const html = response.data;
    const $ = cheerio.load(html);
    
    // Extract text content
    $("script, style, nav, footer, header").remove();
    const text = $("body").text().trim().replace(/\s+/g, " ");

    // Check if page has meaningful content
    // For team/people/about pages, require at least 1000 chars to ensure we got actual team data
    // For team/people/about pages, require more content (1000 chars)
    // For homepages, be more lenient (100 chars) since they might be JS-rendered
    const isTeamPage = options.url.includes('/team') || options.url.includes('/people') || options.url.includes('/about');
    const minContentLength = isTeamPage ? 1000 : 100;
    
    if (text.length < minContentLength) {
      console.log(`[Scraper] Static HTML has only ${text.length} chars (min: ${minContentLength}), likely JS-rendered`);
      throw new Error(`Page appears to be JavaScript-rendered (only ${text.length} chars of static content)`);
    }
    
    console.log(`[Scraper] Static HTML has ${text.length} chars, looks good`);

    return {
      success: true,
      html,
      text,
      strategy: ScrapingStrategy.STATIC_HTML,
      duration: 0,
      cached: false,
      statusCode: response.status,
      headers: response.headers as Record<string, string>,
    };
  }

  /**
   * Strategy 2/3: Browser scraping (comprehensive)
   */
  private async scrapeBrowser(
    options: ScrapingOptions,
    stealth: boolean
  ): Promise<ScrapingResult> {
    const browser = await this.browserPool.acquire(stealth);
    const page = await browser.newPage();

    try {
      // Set viewport
      await page.setViewport({ width: 1920, height: 1080 });

      // Set user agent
      if (options.userAgent) {
        await page.setUserAgent(options.userAgent);
      }

      // Set cookies
      if (options.cookies) {
        await page.setCookie(...options.cookies);
      }

      // Navigate to page with appropriate wait strategy
      // Use networkidle2 for JS-heavy sites, domcontentloaded for others
      const waitUntil = options.url.includes('a16z.com') || options.url.includes('javascript') 
        ? 'networkidle2' 
        : 'domcontentloaded';
      
      await page.goto(options.url, {
        waitUntil,
        timeout: options.timeout || 30000, // Increased to 30s for JS-heavy sites
      });

      // Wait for specific selector if provided
      if (options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, {
          timeout: 10000,
        });
      } else {
        // Wait longer for dynamic content to load on JS-heavy sites
        const waitTime = options.url.includes('a16z.com') ? 5000 : 2000;
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      // Handle "Load More" buttons for team/people pages
      // This is critical for sites like Bain Capital Ventures that paginate team members
      if (options.url.includes('/team') || options.url.includes('/people') || options.url.includes('/about')) {
        // First try infinite scroll to load lazy content
        await this.infiniteScrollWithDetection(page);
        // Then click any Load More buttons
        await this.clickLoadMoreButtons(page);
      }

      // Extract content
      const html = await page.content();
      const text = await page.evaluate(() => {
        // Remove unwanted elements
        const unwanted = document.querySelectorAll("script, style, nav, footer, header");
        unwanted.forEach((el) => el.remove());
        return document.body.innerText;
      });

      await page.close();
      await this.browserPool.release(browser);

      return {
        success: true,
        html,
        text: text.trim().replace(/\s+/g, " "),
        strategy: stealth ? ScrapingStrategy.STEALTH_BROWSER : ScrapingStrategy.HEADLESS_BROWSER,
        duration: 0,
        cached: false,
      };
    } catch (error) {
      await page.close().catch(() => {});
      await this.browserPool.release(browser);
      throw error;
    }
  }

  /**
   * Auto-scroll page to trigger lazy loading
   */
  private async autoScroll(page: any): Promise<void> {
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let totalHeight = 0;
        const distance = 300;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;

          if (totalHeight >= scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    });
  }

  /**
   * Infinite scroll with content detection
   * Scrolls until no new content loads or max attempts reached
   */
  private async infiniteScrollWithDetection(page: any): Promise<void> {
    const maxScrollAttempts = 15; // Max scroll iterations
    const scrollDelay = 1500; // Wait time between scrolls for content to load
    let previousHeight = 0;
    let noChangeCount = 0;
    const maxNoChange = 3; // Stop after 3 scrolls with no new content

    console.log(`[Infinite Scroll] Starting scroll detection...`);

    for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
      // Get current scroll height
      const currentHeight = await page.evaluate(() => document.body.scrollHeight);
      
      // Scroll to bottom
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      
      // Wait for potential new content to load
      await new Promise(resolve => setTimeout(resolve, scrollDelay));
      
      // Check if new content loaded
      const newHeight = await page.evaluate(() => document.body.scrollHeight);
      
      if (newHeight === previousHeight) {
        noChangeCount++;
        if (noChangeCount >= maxNoChange) {
          console.log(`[Infinite Scroll] No new content after ${noChangeCount} scrolls, stopping`);
          break;
        }
      } else {
        noChangeCount = 0; // Reset counter when new content loads
        console.log(`[Infinite Scroll] New content loaded (height: ${previousHeight} → ${newHeight})`);
      }
      
      previousHeight = newHeight;
    }

    // Scroll back to top for consistent extraction
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log(`[Infinite Scroll] Completed`);
  }

  /**
   * Click "Load More" buttons to load all paginated content
   * Common patterns: "Load More", "Show More", "View All", "See All", etc.
   */
  private async clickLoadMoreButtons(page: any): Promise<void> {
    const loadMoreSelectors = [
      // Text-based selectors (case-insensitive via XPath)
      '//button[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "load more")]',
      '//button[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "show more")]',
      '//button[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "view all")]',
      '//button[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "see all")]',
      '//button[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "show all")]',
      '//a[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "load more")]',
      '//a[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "show more")]',
      '//a[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "view all")]',
      '//a[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "see all")]',
      '//a[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "show all")]',
      // CSS selectors for common class patterns
      'button.load-more',
      'button.show-more',
      'button[class*="load-more"]',
      'button[class*="show-more"]',
      'a.load-more',
      'a.show-more',
      'a[class*="load-more"]',
      'a[class*="show-more"]',
      // Div/span buttons (some sites use these)
      'div[role="button"][class*="load"]',
      'div[role="button"][class*="more"]',
    ];

    let clickCount = 0;
    const maxClicks = 20; // Prevent infinite loops

    for (let attempt = 0; attempt < maxClicks; attempt++) {
      let clicked = false;

      for (const selector of loadMoreSelectors) {
        try {
          let element;
          
          if (selector.startsWith('//')) {
            // XPath selector
            const elements = await page.$x(selector);
            if (elements.length > 0) {
              element = elements[0];
            }
          } else {
            // CSS selector
            element = await page.$(selector);
          }

          if (element) {
            // Check if element is visible
            const isVisible = await element.evaluate((el: Element) => {
              const style = window.getComputedStyle(el);
              return style.display !== 'none' && 
                     style.visibility !== 'hidden' && 
                     style.opacity !== '0' &&
                     (el as HTMLElement).offsetParent !== null;
            });

            if (isVisible) {
              console.log(`[Load More] Clicking button (attempt ${attempt + 1}): ${selector}`);
              
              // Scroll element into view
              await element.evaluate((el: Element) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
              await new Promise(resolve => setTimeout(resolve, 500));
              
              // Click the element
              await element.click();
              clickCount++;
              clicked = true;
              
              // Wait for content to load
              await new Promise(resolve => setTimeout(resolve, 2000));
              
              break; // Try to find more buttons after this click
            }
          }
        } catch (e) {
          // Selector not found or click failed, try next
          continue;
        }
      }

      if (!clicked) {
        // No more buttons found
        break;
      }
    }

    if (clickCount > 0) {
      console.log(`[Load More] Clicked ${clickCount} "Load More" buttons`);
    }
  }

  /**
   * Generate cache key from options
   */
  private getCacheKey(options: ScrapingOptions): string {
    return `scrape:${options.url}`;
  }

  /**
   * Record scraping metrics
   */
  private recordMetrics(metrics: ScrapingMetrics): void {
    this.metrics.push(metrics);
    
    // Keep only last 1000 metrics
    if (this.metrics.length > 1000) {
      this.metrics = this.metrics.slice(-1000);
    }
  }

  /**
   * Get scraping statistics
   */
  getStats() {
    const total = this.metrics.length;
    if (total === 0) {
      return {
        total: 0,
        successRate: 0,
        avgDuration: 0,
        cacheHitRate: 0,
        byStrategy: {},
      };
    }

    const successful = this.metrics.filter((m) => m.success).length;
    const cached = this.metrics.filter((m) => m.cached).length;
    const avgDuration =
      this.metrics.reduce((sum, m) => sum + m.duration, 0) / total;

    const byStrategy: Record<string, any> = {};
    for (const strategy of Object.values(ScrapingStrategy)) {
      const strategyMetrics = this.metrics.filter((m) => m.strategy === strategy);
      if (strategyMetrics.length > 0) {
        byStrategy[strategy] = {
          total: strategyMetrics.length,
          successful: strategyMetrics.filter((m) => m.success).length,
          avgDuration:
            strategyMetrics.reduce((sum, m) => sum + m.duration, 0) /
            strategyMetrics.length,
        };
      }
    }

    return {
      total,
      successRate: (successful / total) * 100,
      avgDuration,
      cacheHitRate: (cached / total) * 100,
      byStrategy,
      browserPoolStats: this.browserPool.getStats(),
      cacheStats: this.cache.getStats(),
    };
  }
}

// Singleton instance
let scraper: ComprehensiveScraper | null = null;

export function getScraper(): ComprehensiveScraper {
  if (!scraper) {
    scraper = new ComprehensiveScraper();
  }
  return scraper;
}
