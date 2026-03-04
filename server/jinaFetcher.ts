/**
 * Jina AI Reader API Integration
 * Fast, reliable website content extraction with Puppeteer fallback
 */

import axios from 'axios';

interface JinaFetchResult {
  success: boolean;
  content: string | null;
  format: 'markdown' | 'html';
  source: 'jina' | 'puppeteer';
  error?: string;
  duration: number;
}

/**
 * Fetch website content via Jina AI Reader API
 * Returns clean markdown content
 */
export async function fetchViaJina(url: string): Promise<JinaFetchResult | null> {
  const startTime = Date.now();
  const apiKey = process.env.JINA_API_KEY;

  if (!apiKey) {
    console.log('[Jina] JINA_API_KEY not set, skipping Jina');
    return null;
  }

  try {
    console.log(`[Jina] Fetching ${url}`);

    // Jina Reader API endpoint
    const jinaUrl = `https://r.jina.ai/${url}`;

    const response = await axios.get(jinaUrl, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'text/markdown',
      },
      timeout: 15000, // 15 second timeout
    });

    if (response.status === 200 && response.data) {
      const duration = Date.now() - startTime;
      console.log(`[Jina] ✅ Success (${duration}ms): ${url}`);

      return {
        success: true,
        content: response.data,
        format: 'markdown',
        source: 'jina',
        duration,
      };
    }

    return null;
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Log different error types
    if (errorMsg.includes('timeout')) {
      console.log(`[Jina] ⏱️ Timeout (${duration}ms): ${url}`);
    } else if (errorMsg.includes('403') || errorMsg.includes('429')) {
      console.log(`[Jina] 🚫 Rate limited/blocked (${duration}ms): ${url}`);
    } else if (errorMsg.includes('404')) {
      console.log(`[Jina] 🔍 Not found (${duration}ms): ${url}`);
    } else {
      console.log(`[Jina] ❌ Error (${duration}ms): ${errorMsg}`);
    }

    return null;
  }
}

/**
 * Detect Cloudflare challenge/CAPTCHA pages that Jina returns as HTTP 200
 */
function isCloudflareChallenge(content: string): boolean {
  const s = content.toLowerCase();
  return (
    s.includes("just a moment") ||
    s.includes("checking your browser") ||
    s.includes("challenge-running") ||
    s.includes("enable javascript and cookies") ||
    (s.includes("cloudflare") && (s.includes("challenge") || s.includes("ray id")))
  );
}

/**
 * Fetch website content with Jina + Puppeteer running in parallel.
 * Puppeteer starts after a 4-second delay — fast Jina pages resolve before
 * Puppeteer ever launches. For Cloudflare-protected or JS-heavy pages, Puppeteer
 * wins the race after the delay.
 */
export async function fetchWebsiteContentHybrid(
  url: string,
  puppeteerFallback: () => Promise<string | null>
): Promise<JinaFetchResult> {
  const startTime = Date.now();

  const validateJina = (r: JinaFetchResult | null): JinaFetchResult | null => {
    if (!r?.success || !r.content) return null;
    const len = r.content.trim().length;
    if (len < 200) {
      console.log(`[Hybrid] Jina minimal content (${len} chars) for ${url}`);
      return null;
    }
    if (isCloudflareChallenge(r.content)) {
      console.log(`[Hybrid] Cloudflare challenge detected for ${url}`);
      return null;
    }
    return r;
  };

  // Jina starts immediately
  const jinaPromise: Promise<JinaFetchResult | null> = fetchViaJina(url)
    .then(validateJina)
    .catch(() => null);

  // Puppeteer starts after 4s delay — won't launch at all for fast Jina pages
  const puppeteerPromise: Promise<JinaFetchResult | null> = new Promise<void>(
    resolve => setTimeout(resolve, 4000)
  )
    .then(() => puppeteerFallback())
    .then(content => {
      if (!content || content.trim().length < 200) return null;
      const duration = Date.now() - startTime;
      console.log(`[Hybrid] ✅ Puppeteer won race (${duration}ms): ${url}`);
      return {
        success: true as const,
        content,
        format: 'html' as const,
        source: 'puppeteer' as const,
        duration,
      };
    })
    .catch(() => null);

  // Take whichever gives real content first
  const result = await Promise.any([
    jinaPromise.then(r => { if (!r) throw new Error('empty'); return r; }),
    puppeteerPromise.then(r => { if (!r) throw new Error('empty'); return r; }),
  ]).catch(() => null);

  if (result) {
    const duration = Date.now() - startTime;
    if (result.source === 'jina') {
      console.log(`[Hybrid] ✅ Jina won race (${duration}ms): ${url}`);
    }
    return { ...result, duration };
  }

  return {
    success: false,
    content: null,
    format: 'html',
    source: 'puppeteer',
    error: 'Both Jina and Puppeteer failed',
    duration: Date.now() - startTime,
  };
}

/**
 * Statistics tracking for Jina vs Puppeteer usage
 */
export class FetchStatistics {
  private jinaSuccesses = 0;
  private jinaFailures = 0;
  private puppeteerSuccesses = 0;
  private puppeteerFailures = 0;
  private totalJinaTime = 0;
  private totalPuppeteerTime = 0;

  recordJinaSuccess(duration: number) {
    this.jinaSuccesses++;
    this.totalJinaTime += duration;
  }

  recordJinaFailure() {
    this.jinaFailures++;
  }

  recordPuppeteerSuccess(duration: number) {
    this.puppeteerSuccesses++;
    this.totalPuppeteerTime += duration;
  }

  recordPuppeteerFailure() {
    this.puppeteerFailures++;
  }

  getStats() {
    const jinaTotal = this.jinaSuccesses + this.jinaFailures;
    const puppeteerTotal = this.puppeteerSuccesses + this.puppeteerFailures;

    return {
      jina: {
        successes: this.jinaSuccesses,
        failures: this.jinaFailures,
        total: jinaTotal,
        successRate: jinaTotal > 0 ? ((this.jinaSuccesses / jinaTotal) * 100).toFixed(1) + '%' : 'N/A',
        avgTime: this.jinaSuccesses > 0 ? (this.totalJinaTime / this.jinaSuccesses).toFixed(0) + 'ms' : 'N/A',
      },
      puppeteer: {
        successes: this.puppeteerSuccesses,
        failures: this.puppeteerFailures,
        total: puppeteerTotal,
        successRate: puppeteerTotal > 0 ? ((this.puppeteerSuccesses / puppeteerTotal) * 100).toFixed(1) + '%' : 'N/A',
        avgTime: this.puppeteerSuccesses > 0 ? (this.totalPuppeteerTime / this.puppeteerSuccesses).toFixed(0) + 'ms' : 'N/A',
      },
      summary: {
        totalRequests: jinaTotal + puppeteerTotal,
        jinaUsageRate: jinaTotal > 0 ? ((jinaTotal / (jinaTotal + puppeteerTotal)) * 100).toFixed(1) + '%' : 'N/A',
      },
    };
  }

  reset() {
    this.jinaSuccesses = 0;
    this.jinaFailures = 0;
    this.puppeteerSuccesses = 0;
    this.puppeteerFailures = 0;
    this.totalJinaTime = 0;
    this.totalPuppeteerTime = 0;
  }
}

export const fetchStats = new FetchStatistics();
