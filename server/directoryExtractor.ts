/**
 * Directory Extractor
 *
 * Extracts individual organisation entry URLs from a directory or listing page.
 * Handles pagination and uses Jina + LLM to identify entry links.
 *
 * Typical use-case: a page like "https://vclist.com/firms" that lists 50+
 * organisations — this extractor turns that page into an array of per-entry
 * URLs that can then be fed into VCEnrichmentService or recursiveScraper.
 */

import { fetchViaJina } from "./jinaFetcher";
import { queuedLLMCall } from "./_core/llmQueue";

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
  /** Max number of pages to follow for pagination (default: 10) */
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

async function fetchPageText(url: string): Promise<string | null> {
  try {
    const result = await fetchViaJina(url);
    if (result?.success && result.content) {
      return result.content;
    }
  } catch {
    // fall through to null
  }
  return null;
}

async function extractEntriesFromText(
  text: string,
  pageUrl: string,
  entryLabel: string,
): Promise<LLMDirectoryResponse> {
  const prompt = `You are analyzing a directory or listing page that contains links to individual ${entryLabel}.

Page URL: ${pageUrl}

Page Content:
${text.substring(0, 12000)}

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
 *
 * @example
 * const result = await extractDirectory("https://example.com/vc-list", {
 *   entryLabel: "VC firms",
 *   maxPages: 5,
 * });
 * console.log(result.entries); // [{ name: "Acme Capital", url: "https://acmecap.com" }, ...]
 */
export async function extractDirectory(
  startUrl: string,
  config: DirectoryExtractorConfig = {},
): Promise<DirectoryExtractionResult> {
  const {
    maxPages = 10,
    delayMs = 1000,
    entryLabel = "organisations",
  } = config;

  const allEntries: DirectoryEntry[] = [];
  const errors: string[] = [];
  let pagesVisited = 0;
  let currentUrl: string | null = startUrl;

  while (currentUrl && pagesVisited < maxPages) {
    console.log(
      `[directoryExtractor] Fetching page ${pagesVisited + 1}: ${currentUrl}`,
    );

    const text = await fetchPageText(currentUrl);
    pagesVisited++;

    if (!text) {
      errors.push(`Failed to fetch: ${currentUrl}`);
      break;
    }

    const { entries, next_page_url } = await extractEntriesFromText(
      text,
      currentUrl,
      entryLabel,
    );

    console.log(
      `[directoryExtractor] Found ${entries.length} entries on page ${pagesVisited}`,
    );
    allEntries.push(...entries);

    // Stop if no next page or next page is the same as current
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
