/**
 * Web Search Module
 *
 * Provides a unified web search interface for the agent loop.
 * Strategy:
 *   1. Serper API (fast, reliable, requires SERPER_API_KEY env var)
 *   2. DuckDuckGo Instant Answer API (free, no key needed, rate-limited)
 *
 * Returns a list of SearchResult objects with title, url, and snippet.
 * The agent uses these to decide which pages to fetch next when the
 * primary website has insufficient data.
 */

import axios from "axios";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ---------------------------------------------------------------------------
// Serper API (primary — fast, reliable, ~$0.001/query)
// ---------------------------------------------------------------------------

async function searchViaSerper(query: string, numResults = 5): Promise<SearchResult[]> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error("SERPER_API_KEY not set");

  const response = await axios.post(
    "https://google.serper.dev/search",
    { q: query, num: numResults },
    {
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      timeout: 10000,
    },
  );

  const organic: Array<{ title: string; link: string; snippet: string }> =
    response.data?.organic ?? [];

  return organic.map((r) => ({
    title: r.title ?? "",
    url: r.link ?? "",
    snippet: r.snippet ?? "",
  }));
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML search (fallback — free, no key, rate-limited)
// ---------------------------------------------------------------------------

async function searchViaDuckDuckGo(query: string, numResults = 5): Promise<SearchResult[]> {
  // Use DuckDuckGo's HTML endpoint (more reliable than the JSON API)
  const encoded = encodeURIComponent(query);
  const response = await axios.get(`https://html.duckduckgo.com/html/?q=${encoded}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; SmartScraper/1.0; +https://github.com/yuvnagra-sudo/Smart-AI-Website-Scraper)",
    },
    timeout: 12000,
  });

  const html: string = response.data ?? "";

  // Extract result links and snippets from the HTML
  const results: SearchResult[] = [];
  const resultBlockRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const titles: Array<{ url: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = resultBlockRegex.exec(html)) !== null) {
    const rawUrl = m[1];
    const rawTitle = m[2].replace(/<[^>]+>/g, "").trim();
    // DuckDuckGo wraps URLs in a redirect — extract the actual URL
    const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
    const url = uddgMatch ? decodeURIComponent(uddgMatch[1]) : rawUrl;
    if (url.startsWith("http")) titles.push({ url, title: rawTitle });
  }

  const snippets: string[] = [];
  while ((m = snippetRegex.exec(html)) !== null) {
    snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
  }

  for (let i = 0; i < Math.min(titles.length, numResults); i++) {
    results.push({
      title: titles[i].title,
      url: titles[i].url,
      snippet: snippets[i] ?? "",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search the web for `query` and return up to `numResults` results.
 * Tries Serper first (if SERPER_API_KEY is set), falls back to DuckDuckGo.
 */
export async function webSearch(query: string, numResults = 5): Promise<SearchResult[]> {
  // Try Serper first
  if (process.env.SERPER_API_KEY) {
    try {
      const results = await searchViaSerper(query, numResults);
      if (results.length > 0) {
        console.log(`[webSearch] Serper: ${results.length} results for "${query}"`);
        return results;
      }
    } catch (err) {
      console.warn(`[webSearch] Serper failed: ${err instanceof Error ? err.message : String(err).slice(0, 100)} — falling back to DuckDuckGo`);
    }
  }

  // Fall back to DuckDuckGo
  try {
    const results = await searchViaDuckDuckGo(query, numResults);
    console.log(`[webSearch] DuckDuckGo: ${results.length} results for "${query}"`);
    return results;
  } catch (err) {
    console.error(`[webSearch] DuckDuckGo also failed: ${err instanceof Error ? err.message : String(err).slice(0, 100)}`);
    return [];
  }
}

/**
 * Build a targeted search query for a specific company and field.
 * e.g. searchQueryForField("Acme Corp", "acmecorp.com", "funding_stage")
 *   → "Acme Corp acmecorp.com funding stage"
 */
export function searchQueryForField(
  companyName: string,
  websiteUrl: string,
  fieldLabel: string,
): string {
  // Extract domain for cleaner queries
  let domain = "";
  try { domain = new URL(websiteUrl).hostname.replace(/^www\./, ""); } catch { /* ignore */ }

  // Convert snake_case / camelCase field keys to readable words
  const readable = fieldLabel
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();

  return `${companyName}${domain ? ` ${domain}` : ""} ${readable}`;
}
