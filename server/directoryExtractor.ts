/**
 * Directory Extractor
 *
 * Extracts individual organisation entry URLs from a directory or listing page.
 * Handles pagination and uses heuristic link extraction first, falling back to
 * LLM only when heuristics can't find entries.
 *
 * Strategy per page:
 *  1. Fetch via Jina (fast, handles static HTML)
 *  2. Run heuristic link extraction on the Jina markdown output
 *     - Detects the URL pattern common to all entry links (e.g. /profile/)
 *     - Re-uses that pattern on all subsequent pages (no LLM needed)
 *  3. If heuristic finds < 3 entries → retry with Puppeteer (JS-rendered pages)
 *     - For Puppeteer output, run cheerio-based HTML link extraction
 *  4. If still < 3 entries → fall back to LLM (handles unusual layouts)
 *
 * Pagination strategy (in order):
 *  1. rel="next" link in content
 *  2. ?page=N / /page/N URL increment
 *  3. LLM fallback
 */

import * as cheerio from "cheerio";
import { fetchViaJina } from "./jinaFetcher";
import { queuedLLMCall } from "./_core/llmQueue";
import { withDomainRateLimit } from "./_core/domainRateLimiter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DirectoryEntry {
  /** Display name of the organisation (may be empty if LLM can't determine) */
  name: string;
  /** Canonical URL for the organisation's own website or directory profile */
  url: string;
}

export interface DirectoryExtractionResult {
  entries: DirectoryEntry[];
  /** Total pages visited during extraction */
  pagesVisited: number;
  errors: string[];
}

export interface DirectoryExtractorConfig {
  /** Max number of pages to follow for pagination (default: 500) */
  maxPages?: number;
  /** Delay between page fetches in ms (default: 1000) */
  delayMs?: number;
  /**
   * Label used in the LLM prompt to describe what's being listed.
   * e.g. "VC firms", "healthcare providers", "real-estate agents"
   * Defaults to "organisations".
   */
  entryLabel?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface LLMDirectoryResponse {
  entries: Array<{ name: string; url: string }>;
  next_page_url: string | null;
}

/** Domains that should never be treated as company entry URLs */
const SKIP_DOMAINS = [
  "twitter.com", "x.com", "facebook.com", "linkedin.com", "instagram.com",
  "youtube.com", "google.com", "apple.com", "microsoft.com",
];

function isSkipUrl(url: string): boolean {
  // Redirect/tracking URLs are extremely long — no real company URL is 500+ chars
  if (url.length > 500) return true;
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.toLowerCase();
    // Skip image/static CDN subdomains (e.g. img.shgstatic.com, cdn.clutch.co)
    if (/^(img|cdn|static|assets|media|images|s3|files)\./.test(host)) return true;
    // Skip redirect/tracking subdomains (e.g. r.clutch.co, go.example.com)
    if (/^(r|go|redirect|track|click|out)\./.test(host)) return true;
    // Skip redirect paths
    if (pathname.startsWith("/redirect") || pathname.startsWith("/go/") || pathname.startsWith("/out/")) return true;
    return SKIP_DOMAINS.some(d => host === d || host.endsWith("." + d));
  } catch { return true; }
}

// ---------------------------------------------------------------------------
// Heuristic: extract entry links from Jina markdown
// ---------------------------------------------------------------------------

/**
 * Parses markdown `[text](url)` links and tries to detect a common entry URL
 * pattern. Returns entries and the detected pattern (for use on later pages).
 */
function heuristicExtractFromMarkdown(
  markdown: string,
  pageUrl: string,
  knownPattern?: string,
): { entries: DirectoryEntry[]; detectedPattern?: string } {
  let pageHost = "";
  try { pageHost = new URL(pageUrl).hostname; } catch { /* ignore */ }

  // Extract all markdown links
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const allLinks: DirectoryEntry[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(markdown)) !== null) {
    const name = m[1].trim();
    const url = m[2].replace(/[.,;)>]+$/, "").trim();
    if (name.length < 2 || name.length > 150) continue;
    if (isSkipUrl(url)) continue;
    allLinks.push({ name, url });
  }

  if (allLinks.length === 0) return { entries: [] };

  // If we already know the entry URL pattern, filter by it
  if (knownPattern) {
    const matching = allLinks.filter(l => {
      try { return new URL(l.url).pathname.startsWith(knownPattern); } catch { return false; }
    });
    if (matching.length > 0) return { entries: matching, detectedPattern: knownPattern };
  }

  // Try to detect pattern from same-host links
  const sameHost = allLinks.filter(l => {
    try { return new URL(l.url).hostname === pageHost; } catch { return false; }
  });

  if (sameHost.length >= 3) {
    // Count path-prefix occurrences
    const prefixCounts = new Map<string, number>();
    for (const l of sameHost) {
      try {
        const segments = new URL(l.url).pathname.split("/").filter(Boolean);
        if (segments.length >= 2) {
          const prefix = "/" + segments[0] + "/";
          prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
        }
      } catch { /* ignore */ }
    }
    // Find the most common prefix that covers ≥30% of same-host links and ≥3 links
    let bestPrefix = "";
    let bestCount = 0;
    for (const [prefix, count] of prefixCounts) {
      if (count > bestCount && count >= 3 && count / sameHost.length >= 0.3) {
        bestCount = count;
        bestPrefix = prefix;
      }
    }
    if (bestPrefix) {
      const matching = sameHost.filter(l => {
        try { return new URL(l.url).pathname.startsWith(bestPrefix); } catch { return false; }
      });
      if (matching.length >= 3) {
        return { entries: matching, detectedPattern: bestPrefix };
      }
    }
  }

  // No same-host pattern — return external links (e.g. VC list pages linking to company sites)
  const external = allLinks.filter(l => {
    try { return new URL(l.url).hostname !== pageHost; } catch { return false; }
  });
  if (external.length >= 3) return { entries: external };

  return { entries: [] };
}

// ---------------------------------------------------------------------------
// Heuristic: extract entry links from raw HTML (Puppeteer output)
// ---------------------------------------------------------------------------

function heuristicExtractFromHtml(
  html: string,
  pageUrl: string,
  knownPattern?: string,
): { entries: DirectoryEntry[]; detectedPattern?: string } {
  let pageHost = "";
  try { pageHost = new URL(pageUrl).hostname; } catch { /* ignore */ }

  const $ = cheerio.load(html);
  const allLinks: DirectoryEntry[] = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const text = $(el).text().trim().replace(/\s+/g, " ");
    let absUrl = href;
    try {
      absUrl = new URL(href, pageUrl).href;
    } catch { return; }
    if (!absUrl.startsWith("http")) return;
    if (text.length < 2 || text.length > 150) return;
    if (isSkipDomain(absUrl)) return;
    allLinks.push({ name: text, url: absUrl.replace(/[.,;)>]+$/, "") });
  });

  if (allLinks.length === 0) return { entries: [] };

  // Apply same pattern detection as markdown extractor
  if (knownPattern) {
    const matching = allLinks.filter(l => {
      try { return new URL(l.url).pathname.startsWith(knownPattern); } catch { return false; }
    });
    if (matching.length > 0) return { entries: matching, detectedPattern: knownPattern };
  }

  const sameHost = allLinks.filter(l => {
    try { return new URL(l.url).hostname === pageHost; } catch { return false; }
  });

  if (sameHost.length >= 3) {
    const prefixCounts = new Map<string, number>();
    for (const l of sameHost) {
      try {
        const segments = new URL(l.url).pathname.split("/").filter(Boolean);
        if (segments.length >= 2) {
          const prefix = "/" + segments[0] + "/";
          prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
        }
      } catch { /* ignore */ }
    }
    let bestPrefix = "";
    let bestCount = 0;
    for (const [prefix, count] of prefixCounts) {
      if (count > bestCount && count >= 3 && count / sameHost.length >= 0.3) {
        bestCount = count;
        bestPrefix = prefix;
      }
    }
    if (bestPrefix) {
      const matching = sameHost.filter(l => {
        try { return new URL(l.url).pathname.startsWith(bestPrefix); } catch { return false; }
      });
      if (matching.length >= 3) {
        return { entries: matching, detectedPattern: bestPrefix };
      }
    }
  }

  const external = allLinks.filter(l => {
    try { return new URL(l.url).hostname !== pageHost; } catch { return false; }
  });
  if (external.length >= 3) return { entries: external };

  return { entries: [] };
}

// ---------------------------------------------------------------------------
// Heuristic: detect next pagination URL
// ---------------------------------------------------------------------------

function detectNextPageUrl(content: string, currentUrl: string, isHtml: boolean): string | null {
  if (isHtml) {
    const $ = cheerio.load(content);
    // Check rel="next"
    const relNext = $('a[rel="next"], link[rel="next"]').first().attr("href");
    if (relNext) {
      try { return new URL(relNext, currentUrl).href; } catch { /* ignore */ }
    }
    // Check common "Next" link text
    let nextHref: string | null = null;
    $("a").each((_, el) => {
      const text = $(el).text().trim().toLowerCase();
      if (/^(next|→|»|›|next page|next »)$/.test(text)) {
        const href = $(el).attr("href");
        if (href) {
          try { nextHref = new URL(href, currentUrl).href; } catch { /* ignore */ }
        }
      }
    });
    if (nextHref) return nextHref;
  } else {
    // Markdown: look for [Next](url) or [→](url) patterns
    const nextLinkRegex = /\[(next|→|»|›|next page)[^\]]*\]\((https?:\/\/[^)]+)\)/gi;
    const m = nextLinkRegex.exec(content);
    if (m) return m[2];
  }

  // URL increment: ?page=N or /page/N
  try {
    const cur = new URL(currentUrl);
    const pageParam = cur.searchParams.get("page");
    if (pageParam !== null) {
      const next = parseInt(pageParam, 10) + 1;
      if (!isNaN(next)) {
        cur.searchParams.set("page", String(next));
        // Only use if this page number appears in the content (validates it exists)
        if (content.includes(`page=${next}`) || content.includes(`page%3D${next}`)) {
          return cur.href;
        }
      }
    }
    // /page/N path pattern
    const pagePathMatch = cur.pathname.match(/\/page\/(\d+)(\/.*)?$/);
    if (pagePathMatch) {
      const next = parseInt(pagePathMatch[1], 10) + 1;
      cur.pathname = cur.pathname.replace(/\/page\/\d+/, `/page/${next}`);
      if (content.includes(`/page/${next}`)) return cur.href;
    }
  } catch { /* ignore */ }

  return null;
}

// ---------------------------------------------------------------------------
// LLM fallback: extract entries + next page from text
// ---------------------------------------------------------------------------

async function extractEntriesViaLLM(
  text: string,
  pageUrl: string,
  entryLabel: string,
): Promise<LLMDirectoryResponse> {
  const prompt = `You are analyzing a directory or listing page that contains links to individual ${entryLabel}.

Page URL: ${pageUrl}

Page Content:
${text.substring(0, 20000)}

Your task:
1. Extract every individual ${entryLabel.replace(/s$/, "")} entry with its name and URL.
   - Include direct links to an organisation's own website if present.
   - Also include links to the organisation's profile page within this directory if no external URL is available.
   - Skip navigation links, filters, ads, and general category links.
2. Identify the URL of the next pagination page if one exists (e.g. "Next", "Page 2", "Load More" link).

Return a JSON object with:
- "entries": array of { "name": string, "url": string }
- "next_page_url": string | null  (full absolute URL, or null if no next page)`;

  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "directory_extraction",
          strict: true,
          schema: {
            type: "object",
            properties: {
              entries: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    url: { type: "string" },
                  },
                  required: ["name", "url"],
                  additionalProperties: false,
                },
              },
              next_page_url: { type: ["string", "null"] },
            },
            required: ["entries", "next_page_url"],
            additionalProperties: false,
          },
        },
      },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed: LLMDirectoryResponse = JSON.parse(
      typeof raw === "string" ? raw : "{}",
    );
    return {
      entries: parsed.entries ?? [],
      next_page_url: parsed.next_page_url ?? null,
    };
  } catch (err) {
    console.error("[directoryExtractor] LLM error:", err);
    return { entries: [], next_page_url: null };
  }
}

function dedupeByUrl(entries: DirectoryEntry[]): DirectoryEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = e.url.toLowerCase().replace(/\/$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract all organisation entries from a directory / listing page,
 * following pagination automatically.
 */
export async function extractDirectory(
  startUrl: string,
  config: DirectoryExtractorConfig = {},
): Promise<DirectoryExtractionResult> {
  const {
    maxPages = 500,
    delayMs = 1000,
    entryLabel = "organisations",
  } = config;

  const allEntries: DirectoryEntry[] = [];
  const errors: string[] = [];
  let pagesVisited = 0;
  let currentUrl: string | null = startUrl;
  let detectedPattern: string | undefined;

  while (currentUrl && pagesVisited < maxPages) {
    const pageNum = pagesVisited + 1;
    console.log(`[directoryExtractor] Fetching page ${pageNum}: ${currentUrl}`);

    // ── Fetch via Jina ──────────────────────────────────────────────────────
    let jinaText: string | null = null;
    try {
      const result = await withDomainRateLimit(currentUrl, () => fetchViaJina(currentUrl!));
      if (result?.success && result.content) jinaText = result.content;
    } catch { /* ignore */ }

    pagesVisited++;

    let entries: DirectoryEntry[] = [];
    let next_page_url: string | null = null;
    let rawHtml: string | null = null;

    // ── Heuristic extraction from Jina markdown ─────────────────────────────
    if (jinaText) {
      const heuristic = heuristicExtractFromMarkdown(jinaText, currentUrl, detectedPattern);
      entries = heuristic.entries;
      if (heuristic.detectedPattern) detectedPattern = heuristic.detectedPattern;

      if (entries.length >= 3) {
        // Heuristic succeeded — detect next page before possibly going to LLM
        next_page_url = detectNextPageUrl(jinaText, currentUrl, false);
      }
    }

    // ── Puppeteer fallback for JS-rendered pages ────────────────────────────
    if (entries.length < 3) {
      console.log(`[directoryExtractor] Heuristic found ${entries.length} entries on page ${pageNum}, trying Puppeteer`);
      try {
        const { scrapeWebsite } = await import("./scraper");
        const r = await withDomainRateLimit(currentUrl, () =>
          scrapeWebsite({ url: currentUrl!, cache: true, cacheTTL: 3600, timeout: 60000 })
        );
        if (r.success) {
          rawHtml = r.html || null;
          const puppeteerText = r.text || r.html || null;

          if (rawHtml) {
            const heuristic = heuristicExtractFromHtml(rawHtml, currentUrl, detectedPattern);
            if (heuristic.entries.length > entries.length) {
              entries = heuristic.entries;
              if (heuristic.detectedPattern) detectedPattern = heuristic.detectedPattern;
              console.log(`[directoryExtractor] Puppeteer heuristic found ${entries.length} entries on page ${pageNum}`);
            }
          }

          // Detect next page from HTML
          if (entries.length >= 3 && rawHtml) {
            next_page_url = detectNextPageUrl(rawHtml, currentUrl, true);
          }

          // LLM fallback if heuristic still failing
          if (entries.length < 3 && puppeteerText) {
            console.log(`[directoryExtractor] Heuristic failed, using LLM on page ${pageNum}`);
            const llmResult = await extractEntriesViaLLM(puppeteerText, currentUrl, entryLabel);
            if (llmResult.entries.length > entries.length) {
              entries = llmResult.entries;
              next_page_url = llmResult.next_page_url;
            }
          }
        }
      } catch (err) {
        console.error(`[directoryExtractor] Puppeteer error on page ${pageNum}:`, err instanceof Error ? err.message : String(err));
      }
    }

    // ── LLM fallback on Jina text if still empty ────────────────────────────
    if (entries.length < 3 && jinaText && !rawHtml) {
      console.log(`[directoryExtractor] Using LLM fallback on Jina text for page ${pageNum}`);
      const llmResult = await extractEntriesViaLLM(jinaText, currentUrl, entryLabel);
      if (llmResult.entries.length > entries.length) {
        entries = llmResult.entries;
        next_page_url = llmResult.next_page_url;
      }
    }

    // ── Nothing worked ──────────────────────────────────────────────────────
    if (!jinaText && !rawHtml) {
      errors.push(`Failed to fetch: ${currentUrl}`);
      break;
    }

    // ── LLM for next_page_url if heuristic didn't find one ──────────────────
    if (entries.length >= 3 && next_page_url === null && jinaText) {
      // Only ask LLM for next page if heuristic pagination failed
      const llmResult = await extractEntriesViaLLM(jinaText, currentUrl, entryLabel);
      next_page_url = llmResult.next_page_url;
    }

    console.log(`[directoryExtractor] Found ${entries.length} entries on page ${pageNum}`);
    allEntries.push(...entries);

    // Stop if no next page or same as current
    if (
      !next_page_url ||
      next_page_url.toLowerCase().replace(/\/$/, "") ===
        currentUrl.toLowerCase().replace(/\/$/, "")
    ) {
      break;
    }

    currentUrl = next_page_url;

    if (pagesVisited < maxPages) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return {
    entries: dedupeByUrl(allEntries),
    pagesVisited,
    errors,
  };
}
