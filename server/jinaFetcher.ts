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
      timeout: 8000, // 8 second timeout
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
 * Fetch website content with Jina + Puppeteer fallback
 * Tries Jina first (fast), falls back to Puppeteer if needed
 */
export async function fetchWebsiteContentHybrid(
  url: string,
  puppeteerFallback: () => Promise<string | null>
): Promise<JinaFetchResult> {
  const startTime = Date.now();

  // Try Jina first
  const jinaResult = await fetchViaJina(url);
  if (jinaResult?.success && jinaResult.content) {
    // Check if Jina returned meaningful content
    const contentLength = jinaResult.content.trim().length;
    
    // If content is too short (<200 chars), likely failed to extract properly
    if (contentLength < 200) {
      console.log(`[Hybrid] Jina returned minimal content (${contentLength} chars), triggering Puppeteer fallback`);
      // Fall through to Puppeteer fallback
    } else {
      return jinaResult;
    }
  }

  // Fallback to Puppeteer
  console.log(`[Hybrid] Falling back to Puppeteer for ${url}`);
  const puppeteerStart = Date.now();

  try {
    const content = await puppeteerFallback();

    if (content) {
      const duration = Date.now() - puppeteerStart;
      console.log(`[Puppeteer] ✅ Success (${duration}ms): ${url}`);

      return {
        success: true,
        content,
        format: 'html',
        source: 'puppeteer',
        duration,
      };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(`[Puppeteer] ❌ Error: ${errorMsg}`);
  }

  // Both failed
  const totalDuration = Date.now() - startTime;
  return {
    success: false,
    content: null,
    format: 'html',
    source: 'puppeteer',
    error: 'Both Jina and Puppeteer failed',
    duration: totalDuration,
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
