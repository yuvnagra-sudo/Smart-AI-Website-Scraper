/**
 * Browser-based scraper for JavaScript-rendered content
 * Uses Puppeteer to render pages fully before extracting content
 */

import puppeteer, { Browser, Page } from "puppeteer";

let browserInstance: Browser | null = null;

/**
 * Get or create a shared browser instance
 */
async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.connected) {
    console.log("[Browser Scraper] Launching headless browser...");
    browserInstance = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    });
    console.log("[Browser Scraper] Browser launched successfully");
  }
  return browserInstance;
}

/**
 * Fetch webpage content with JavaScript rendering
 */
export async function fetchWithBrowser(
  url: string,
  options?: {
    waitForSelector?: string;
    waitTime?: number;
    timeout?: number;
  }
): Promise<string | null> {
  const {
    waitForSelector,
    waitTime = 2000, // Default 2s wait for JS to execute
    timeout = 30000, // Default 30s timeout
  } = options || {};

  let page: Page | null = null;

  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // Set user agent to avoid bot detection
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    console.log(`[Browser Scraper] Navigating to ${url}...`);

    // Navigate to page
    await page.goto(url, {
      waitUntil: "networkidle2", // Wait until network is mostly idle
      timeout,
    });

    // Wait for specific selector if provided
    if (waitForSelector) {
      console.log(`[Browser Scraper] Waiting for selector: ${waitForSelector}`);
      await page.waitForSelector(waitForSelector, { timeout: 10000 });
    }

    // Additional wait for dynamic content
    await new Promise(resolve => setTimeout(resolve, waitTime));

    // Get rendered HTML
    const html = await page.content();
    console.log(`[Browser Scraper] Successfully fetched ${url} (${html.length} bytes)`);

    return html;
  } catch (error) {
    console.error(`[Browser Scraper] Error fetching ${url}:`, error);
    return null;
  } finally {
    if (page) {
      await page.close();
    }
  }
}

/**
 * Fetch multiple URLs in parallel with rate limiting
 */
export async function fetchMultipleWithBrowser(
  urls: string[],
  options?: {
    concurrency?: number;
    waitTime?: number;
  }
): Promise<Map<string, string | null>> {
  const { concurrency = 3, waitTime = 2000 } = options || {};
  
  const results = new Map<string, string | null>();
  
  // Process in batches to avoid overwhelming the browser
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    console.log(`[Browser Scraper] Processing batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(urls.length / concurrency)}`);
    
    const batchResults = await Promise.all(
      batch.map(async (url) => {
        const html = await fetchWithBrowser(url, { waitTime });
        return { url, html };
      })
    );
    
    for (const { url, html } of batchResults) {
      results.set(url, html);
    }
  }
  
  return results;
}

/**
 * Close the browser instance
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    console.log("[Browser Scraper] Closing browser...");
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * Fetch with fallback: try browser first, fall back to axios if it fails
 */
export async function fetchWithFallback(
  url: string,
  axiosFallback: () => Promise<string | null>
): Promise<{ html: string | null; method: "browser" | "axios" }> {
  // Try browser-based scraping first
  const browserHtml = await fetchWithBrowser(url);
  
  if (browserHtml && browserHtml.length > 1000) {
    // Success with browser
    return { html: browserHtml, method: "browser" };
  }
  
  console.log(`[Browser Scraper] Browser fetch failed or returned minimal content, falling back to axios...`);
  
  // Fall back to axios
  const axiosHtml = await axiosFallback();
  return { html: axiosHtml, method: "axios" };
}
