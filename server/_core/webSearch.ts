/**
 * Web Search Module
 *
 * Provides a unified web search interface for the agent loop.
 * Provider priority:
 *   1. Jina Search (s.jina.ai) — primary, reliable on Railway, ~$0.0005/query
 *   2. Serper API — secondary, requires SERPER_API_KEY, ~$0.001/query
 *   3. DuckDuckGo HTML — last resort, free, unreliable on Railway (3s timeout)
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
// Jina Search API (primary — reliable on Railway, ~$0.0005/query)
// Uses s.jina.ai which returns structured JSON search results.
// Reuses the same JINA_API_KEY as jinaFetcher — no extra credentials needed.
// ---------------------------------------------------------------------------

async function searchViaJina(query: string, numResults = 5): Promise<SearchResult[]> {
  const apiKey = process.env.JINA_API_KEY;
  if (!apiKey) throw new Error("JINA_API_KEY not set");

  const encoded = encodeURIComponent(query);
  const response = await axios.get(`https://s.jina.ai/${encoded}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "X-Respond-With": "no-content", // metadata only (title, url, description) — faster
    },
    timeout: 15000,
  });

  // Jina returns: { data: [{ title, url, description }] }
  const results: Array<{ title?: string; url?: string; description?: string; content?: string }> =
    response.data?.data ?? response.data?.results ?? [];

  return results.slice(0, numResults).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.description ?? r.content?.slice(0, 300) ?? "",
  }));
}

// ---------------------------------------------------------------------------
// Serper API (secondary — fast, reliable, ~$0.001/query)
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
// DuckDuckGo HTML search (last resort — free, no key, unreliable on Railway)
// Timeout reduced to 3s: Railway blocks DuckDuckGo with immediate connection
// refused — no need to wait 12s for a failure that happens in <100ms.
// ---------------------------------------------------------------------------

async function searchViaDuckDuckGo(query: string, numResults = 5): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query);
  const response = await axios.get(`https://html.duckduckgo.com/html/?q=${encoded}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; SmartScraper/1.0; +https://github.com/yuvnagra-sudo/Smart-AI-Website-Scraper)",
    },
    timeout: 3000, // Reduced from 12s — Railway blocks DDG immediately
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
 *
 * Provider priority:
 *   1. Jina Search (if JINA_API_KEY set) — reliable on Railway
 *   2. Serper (if SERPER_API_KEY set) — fast Google results
 *   3. DuckDuckGo — free fallback (unreliable on Railway, 3s timeout)
 */
export async function webSearch(query: string, numResults = 5): Promise<SearchResult[]> {
  // 1. Try Jina Search first (reliable on Railway, reuses existing JINA_API_KEY)
  if (process.env.JINA_API_KEY) {
    try {
      const results = await searchViaJina(query, numResults);
      if (results.length > 0) {
        console.log(`[webSearch] Jina: ${results.length} results for "${query}"`);
        return results;
      }
      console.warn(`[webSearch] Jina returned 0 results — trying next provider`);
    } catch (err) {
      console.warn(
        `[webSearch] Jina failed: ${err instanceof Error ? err.message : String(err).slice(0, 100)} — trying next provider`,
      );
    }
  }

  // 2. Try Serper
  if (process.env.SERPER_API_KEY) {
    try {
      const results = await searchViaSerper(query, numResults);
      if (results.length > 0) {
        console.log(`[webSearch] Serper: ${results.length} results for "${query}"`);
        return results;
      }
    } catch (err) {
      console.warn(
        `[webSearch] Serper failed: ${err instanceof Error ? err.message : String(err).slice(0, 100)} — falling back to DuckDuckGo`,
      );
    }
  }

  // 3. Last resort: DuckDuckGo (3s timeout)
  try {
    const results = await searchViaDuckDuckGo(query, numResults);
    if (results.length > 0) {
      console.log(`[webSearch] DuckDuckGo: ${results.length} results for "${query}"`);
      return results;
    }
    console.warn(`[webSearch] DuckDuckGo returned 0 results`);
    return [];
  } catch (err) {
    console.error(
      `[webSearch] All providers failed. Last error: ${err instanceof Error ? err.message : String(err).slice(0, 100)}`,
    );
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
