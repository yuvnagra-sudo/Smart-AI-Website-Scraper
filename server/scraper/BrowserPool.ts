/**
 * Browser Pool - Manages reusable browser instances
 * Reduces overhead of creating new browsers for each request
 */

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";
import { BrowserInstance } from "./types";

// Rotate through realistic Chrome user-agent strings to reduce fingerprinting
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
];

// Add stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

export class BrowserPool {
  private browsers: Map<string, BrowserInstance> = new Map();
  private maxBrowsers: number;
  private maxIdleTime: number; // milliseconds
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(maxBrowsers = 15, maxIdleTime = 5 * 60 * 1000) {
    this.maxBrowsers = maxBrowsers;
    this.maxIdleTime = maxIdleTime;
    this.startCleanupTask();
  }

  /**
   * Acquire a browser instance from the pool
   */
  async acquire(stealth = false): Promise<Browser> {
    // Try to reuse an existing browser
    for (const [id, instance] of Array.from(this.browsers.entries())) {
      if (Date.now() - instance.lastUsedAt > 1000) {
        // Not used in last second
        instance.lastUsedAt = Date.now();
        instance.requestCount++;
        console.log(`[BrowserPool] Reusing browser ${id} (${instance.requestCount} requests)`);
        return instance.browser;
      }
    }

    // Create new browser if under limit
    if (this.browsers.size < this.maxBrowsers) {
      const browser = await this.createBrowser(stealth);
      const id = `browser-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      const instance: BrowserInstance = {
        id,
        browser,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        requestCount: 1,
        memoryUsage: 0,
      };

      this.browsers.set(id, instance);
      console.log(`[BrowserPool] Created new browser ${id} (${this.browsers.size}/${this.maxBrowsers})`);
      return browser;
    }

    // Wait and retry if at capacity
    console.log(`[BrowserPool] At capacity, waiting for available browser...`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return this.acquire(stealth);
  }

  /**
   * Create a new browser instance
   */
  private async createBrowser(stealth: boolean): Promise<Browser> {
    // Pick a random UA + viewport to reduce fingerprint consistency across browsers
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const vp = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];

    const proxyUrl = process.env.PROXY_URL;

    const args = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      `--user-agent=${ua}`,
      `--window-size=${vp.width},${vp.height}`,
      ...(proxyUrl ? [`--proxy-server=${proxyUrl}`] : []),
    ];

    if (stealth) {
      args.push(
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process"
      );
    }

    const browser = await puppeteer.launch({
      headless: true,
      args,
      // ignoreHTTPSErrors: true,
    });

    if (proxyUrl) {
      console.log(`[BrowserPool] Proxy enabled: ${proxyUrl}`);
    }

    return browser as unknown as Browser;
  }

  /**
   * Release a browser back to the pool (no-op, just updates timestamp)
   */
  async release(browser: Browser): Promise<void> {
    for (const [id, instance] of Array.from(this.browsers.entries())) {
      if (instance.browser === browser) {
        instance.lastUsedAt = Date.now();
        console.log(`[BrowserPool] Released browser ${id}`);
        return;
      }
    }
  }

  /**
   * Close a specific browser instance
   */
  private async closeBrowser(id: string): Promise<void> {
    const instance = this.browsers.get(id);
    if (instance) {
      try {
        await instance.browser.close();
        this.browsers.delete(id);
        console.log(`[BrowserPool] Closed browser ${id}`);
      } catch (error) {
        console.error(`[BrowserPool] Error closing browser ${id}:`, error);
      }
    }
  }

  /**
   * Cleanup idle browsers
   */
  private async cleanup(): Promise<void> {
    const now = Date.now();
    const toClose: string[] = [];

    for (const [id, instance] of Array.from(this.browsers.entries())) {
      const idleTime = now - instance.lastUsedAt;
      if (idleTime > this.maxIdleTime) {
        toClose.push(id);
      }
    }

    for (const id of toClose) {
      await this.closeBrowser(id);
    }

    if (toClose.length > 0) {
      console.log(`[BrowserPool] Cleaned up ${toClose.length} idle browsers`);
    }
  }

  /**
   * Start periodic cleanup task
   */
  private startCleanupTask(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup().catch((error) => {
        console.error("[BrowserPool] Cleanup error:", error);
      });
    }, 60 * 1000); // Run every minute
  }

  /**
   * Close all browsers and stop cleanup task
   */
  async destroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    const closePromises = Array.from(this.browsers.keys()).map((id) =>
      this.closeBrowser(id)
    );
    await Promise.all(closePromises);
    
    console.log("[BrowserPool] Destroyed all browsers");
  }

  /**
   * Get pool statistics
   */
  getStats() {
    const instances = Array.from(this.browsers.values());
    return {
      total: instances.length,
      maxBrowsers: this.maxBrowsers,
      totalRequests: instances.reduce((sum, i) => sum + i.requestCount, 0),
      avgRequestsPerBrowser:
        instances.length > 0
          ? instances.reduce((sum, i) => sum + i.requestCount, 0) / instances.length
          : 0,
      oldestBrowser: instances.length > 0
        ? Math.min(...instances.map((i) => i.createdAt))
        : null,
    };
  }
}

// Singleton instance
let browserPool: BrowserPool | null = null;

export function getBrowserPool(): BrowserPool {
  if (!browserPool) {
    browserPool = new BrowserPool();
  }
  return browserPool;
}

export async function destroyBrowserPool(): Promise<void> {
  if (browserPool) {
    await browserPool.destroy();
    browserPool = null;
  }
}
