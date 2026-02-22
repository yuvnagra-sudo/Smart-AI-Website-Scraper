/**
 * Comprehensive Scraper Type Definitions
 */

export interface ScrapingOptions {
  url: string;
  timeout?: number;
  waitForSelector?: string;
  headers?: Record<string, string>;
  cookies?: Array<{ name: string; value: string; domain?: string }>;
  proxy?: string;
  userAgent?: string;
  javascript?: boolean;
  cache?: boolean;
  cacheTTL?: number; // seconds
}

export interface ScrapingResult {
  success: boolean;
  html?: string;
  text?: string;
  data?: any;
  strategy: ScrapingStrategy;
  duration: number;
  cached: boolean;
  error?: string;
  statusCode?: number;
  headers?: Record<string, string>;
}

export enum ScrapingStrategy {
  API_INTERCEPTION = "api_interception",
  STATIC_HTML = "static_html",
  HEADLESS_BROWSER = "headless_browser",
  STEALTH_BROWSER = "stealth_browser",
}

export interface ScrapingContext {
  url: string;
  domain: string;
  previousAttempts: number;
  lastError?: string;
  cacheAvailable: boolean;
}

export interface TeamMember {
  name: string;
  title: string;
  linkedinUrl?: string;
  email?: string;
  bio?: string;
  imageUrl?: string;
  tier?: string;
}

export interface ScrapingMetrics {
  strategy: ScrapingStrategy;
  duration: number;
  success: boolean;
  cached: boolean;
  retryCount: number;
  error?: string;
  timestamp: number;
}

export interface BrowserInstance {
  id: string;
  browser: any; // Puppeteer Browser or Playwright Browser
  createdAt: number;
  lastUsedAt: number;
  requestCount: number;
  memoryUsage: number;
}

export interface RateLimitConfig {
  requestsPerSecond: number;
  burstSize: number;
  retryAfter: number; // seconds
}

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number; // seconds
  key: string;
}

export interface CircuitBreakerState {
  failures: number;
  lastFailureTime: number;
  state: "closed" | "open" | "half-open";
  nextAttemptTime: number;
}
