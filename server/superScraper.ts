/**
 * Super Scraper Engine
 * ====================
 *
 * A 5-phase escalation engine that merges the zero-cost speed of deterministic
 * extraction with the deep reasoning and multi-hop traversal of the LLM agent loop.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PHASE 1 — Fast Discovery & Parallel Fetch              Cost: $0.00    │
 * │    Sitemap parsing + heuristic URL scoring                              │
 * │    Parallel Jina/Puppeteer fetch of top 10 pages                        │
 * │    Deep team profile link detection (detectTeamMemberProfileLinks)      │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  PHASE 2 — Deterministic Extraction                     Cost: $0.00    │
 * │    Regex: emails, phones, LinkedIn URLs                                 │
 * │    JSON-LD / Schema.org via cheerio                                     │
 * │    mailto: link extraction from raw HTML                                │
 * │    Pre-fill confidence scoring                                          │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  ASSESSMENT GATE: all critical fields filled?                           │
 * │    YES → skip to Phase 5                                                │
 * │    NO  → continue to Phase 3                                            │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  PHASE 3 — Targeted LLM Extraction                      Cost: ~$0.002  │
 * │    Single LLM call on best 3 pages for missing fields only              │
 * │    Uses queuedLLMCall with structured JSON output                       │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  ASSESSMENT GATE: critical fields filled?                               │
 * │    YES → skip to Phase 5                                                │
 * │    NO  → continue to Phase 4                                            │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  PHASE 4 — Agentic Escalation (bounded)                 Cost: ~$0.01   │
 * │    LLM planner: fetch_url | web_search | done                           │
 * │    Web search via Jina Search API (multi-query diversification)         │
 * │    Multi-region/stage team page detection                               │
 * │    Diminishing-returns early-stop                                       │
 * │    Hard cap: SUPER_SCRAPER_AGENT_HOPS (default: 4)                      │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  PHASE 5 — Final LLM Consolidation                      Cost: ~$0.001  │
 * │    One final LLM pass to fill any remaining gaps                        │
 * │    Combines all page content gathered across phases                     │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Activation: set USE_SUPER_SCRAPER=true in Railway environment variables.
 */

import * as cheerio from "cheerio";
import { fetchViaJina, fetchWebsiteContentHybrid } from "./jinaFetcher";
import { queuedLLMCall } from "./_core/llmQueue";
import { detectTeamMemberProfileLinks } from "./deepTeamProfileScraper";
import { generateStandardURLs, discoverRelevantURLs } from "./multiUrlDiscovery";
import type { AgentSection, AgentScrapeResult, ScrapeStats } from "./agentScraper";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max pages fetched in Phase 1 parallel sweep. */
const MAX_PARALLEL_PAGES = parseInt(process.env.SUPER_MAX_PAGES ?? "10", 10);

/** Concurrency for Phase 1 parallel fetch. */
const FETCH_CONCURRENCY = parseInt(process.env.SUPER_FETCH_CONCURRENCY ?? "5", 10);

/** Max agent hops in Phase 4 escalation. Kept low — this is a last resort. */
const MAX_AGENT_HOPS = parseInt(process.env.SUPER_SCRAPER_AGENT_HOPS ?? "4", 10);

/** Max individual team member profiles to deep-scrape in Phase 4. */
const MAX_DEEP_PROFILES = parseInt(process.env.SUPER_MAX_DEEP_PROFILES ?? "6", 10);

/** Confidence threshold — fields above this are considered "filled". */
const CONFIDENCE_THRESHOLD = 0.65;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface FieldResult {
  value: string;
  confidence: number;
  sourceUrl?: string;
}

type FieldResultMap = Record<string, FieldResult>;

interface FetchedPage {
  url: string;
  content: string;
  rawHtml?: string;
  links: string[];
}

// ---------------------------------------------------------------------------
// URL scoring helpers
// ---------------------------------------------------------------------------

/** Score a URL for relevance to B2B contact extraction. Higher = fetch first. */
function scoreUrl(url: string): number {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (/\/(contact|contact-us|contactus|get-in-touch)/.test(path)) return 100;
    if (/\/(team|our-team|leadership|management|people|staff|founders|partners|about-us\/team)/.test(path)) return 95;
    if (path === "/" || path === "") return 90;
    if (/\/(about|about-us|who-we-are|company)/.test(path)) return 80;
    if (/\/(portfolio|work|clients|investments)/.test(path)) return 60;
    if (/\/(services|solutions|what-we-do)/.test(path)) return 50;
    return 30;
  } catch { return 30; }
}

/** Deduplicate, filter to same-domain, and sort URLs by score. */
function prioritiseUrls(urls: string[], baseUrl: string, max: number): string[] {
  let baseDomain = "";
  try { baseDomain = new URL(baseUrl).hostname; } catch { /* ignore */ }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    try {
      const p = new URL(u);
      if (p.hostname !== baseDomain && !p.hostname.endsWith(`.${baseDomain}`)) continue;
      if (/\.(jpg|jpeg|png|gif|svg|pdf|zip|css|js|woff|ttf|ico)$/i.test(p.pathname)) continue;
      const norm = `${p.origin}${p.pathname}`.replace(/\/$/, "") || p.origin;
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
    } catch { /* skip */ }
  }
  return out.sort((a, b) => scoreUrl(b) - scoreUrl(a)).slice(0, max);
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

/** Fetch a URL with Jina/Puppeteer hybrid + raw HTML sidecar for JSON-LD. */
async function fetchPage(
  url: string,
  isCancelled?: () => boolean,
): Promise<FetchedPage | null> {
  if (isCancelled?.()) return null;

  let rawHtmlFromPuppeteer: string | null = null;

  const result = await fetchWebsiteContentHybrid(url, async () => {
    try {
      const { scrapeWebsite } = await import("./scraper");
      const r = await scrapeWebsite({ url, cache: true, cacheTTL: 7 * 24 * 60 * 60, timeout: 45000 });
      if (r.success) {
        rawHtmlFromPuppeteer = r.html || null;
        return r.text || r.html || null;
      }
      return null;
    } catch { return null; }
  });

  if (!result?.success || !result.content) return null;

  // Extract links from markdown content
  const links: string[] = [];
  const seen = new Set<string>();
  const mdPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const barePattern = /https?:\/\/[^\s"'<>)\]]+/g;
  let m: RegExpExecArray | null;
  while ((m = mdPattern.exec(result.content)) !== null) {
    const u = m[2].replace(/[.,;)>\]"']+$/, "");
    if (!seen.has(u)) { seen.add(u); links.push(u); }
  }
  while ((m = barePattern.exec(result.content)) !== null) {
    const u = m[0].replace(/[.,;)>\]"']+$/, "");
    if (!seen.has(u)) { seen.add(u); links.push(u); }
  }

  // Get raw HTML for JSON-LD/cheerio extraction if Jina was used
  let rawHtml: string | undefined = rawHtmlFromPuppeteer ?? undefined;
  if (!rawHtml && result.source === "jina") {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; SuperScraper/1.0)" },
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) {
        const html = await resp.text();
        if (html.length > 500) rawHtml = html;
      }
    } catch { /* non-fatal */ }
  }

  return { url, content: result.content, rawHtml, links };
}

// ---------------------------------------------------------------------------
// Deterministic extraction helpers (Phase 2)
// ---------------------------------------------------------------------------

/** Extract emails from HTML and markdown content. */
function extractEmails(content: string, rawHtml?: string): string[] {
  const emails = new Set<string>();
  const emailRegex = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
  const noisePrefix = /^(info|contact|hello|support|admin|team|press|media|careers|jobs|hr|sales|marketing|legal|privacy|security|noreply|no-reply|webmaster|postmaster|news|newsletter)@/i;

  // From markdown content
  for (const m of (content.match(emailRegex) ?? [])) {
    if (!noisePrefix.test(m)) emails.add(m.toLowerCase());
  }

  // From raw HTML mailto: links (most reliable)
  if (rawHtml) {
    const $ = cheerio.load(rawHtml);
    $('a[href^="mailto:"]').each((_, el) => {
      const href = $(el).attr("href") ?? "";
      const email = href.replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase();
      if (email.match(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/) && !noisePrefix.test(email)) {
        emails.add(email);
      }
    });
  }

  return Array.from(emails);
}

/** Extract LinkedIn profile/company URLs from content. */
function extractLinkedInUrls(content: string): { profiles: string[]; companies: string[] } {
  const profilePattern = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+\/?/g;
  const companyPattern = /https?:\/\/(?:www\.)?linkedin\.com\/company\/[a-zA-Z0-9_-]+\/?/g;
  const profiles = [...new Set(content.match(profilePattern) ?? [])];
  const companies = [...new Set(content.match(companyPattern) ?? [])];
  return { profiles, companies };
}

/** Extract JSON-LD Person/Organization data from raw HTML. */
function extractJsonLd(rawHtml: string): { name?: string; email?: string; telephone?: string; jobTitle?: string; url?: string }[] {
  const results: { name?: string; email?: string; telephone?: string; jobTitle?: string; url?: string }[] = [];
  try {
    const $ = cheerio.load(rawHtml);
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html() ?? "{}");
        const items = Array.isArray(json) ? json : [json];
        for (const item of items) {
          if (!item["@type"]) continue;
          const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
          if (types.some((t: string) => /Person|Employee|ContactPoint/i.test(t))) {
            results.push({
              name: item.name,
              email: item.email,
              telephone: item.telephone,
              jobTitle: item.jobTitle,
              url: item.url,
            });
          }
          // Also check nested employees/members
          const nested = item.employee ?? item.member ?? item.founder ?? [];
          const nestedArr = Array.isArray(nested) ? nested : [nested];
          for (const n of nestedArr) {
            if (n && typeof n === "object") {
              results.push({ name: n.name, email: n.email, telephone: n.telephone, jobTitle: n.jobTitle, url: n.url });
            }
          }
        }
      } catch { /* malformed JSON-LD */ }
    });
  } catch { /* cheerio error */ }
  return results.filter(r => r.name || r.email);
}

/** Extract phone numbers from content. */
function extractPhones(content: string): string[] {
  const phonePattern = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
  return [...new Set(content.match(phonePattern) ?? [])].slice(0, 5);
}

/** Run all deterministic extractors and return a partial FieldResultMap. */
function deterministicExtract(
  pages: FetchedPage[],
  sections: AgentSection[],
): FieldResultMap {
  const result: FieldResultMap = {};

  // Aggregate all emails, LinkedIn URLs, phones, JSON-LD across all pages
  const allEmails: string[] = [];
  const allLinkedInProfiles: string[] = [];
  const allLinkedInCompanies: string[] = [];
  const allPhones: string[] = [];
  const allJsonLd: ReturnType<typeof extractJsonLd> = [];

  for (const page of pages) {
    allEmails.push(...extractEmails(page.content, page.rawHtml));
    const li = extractLinkedInUrls(page.content);
    allLinkedInProfiles.push(...li.profiles);
    allLinkedInCompanies.push(...li.companies);
    allPhones.push(...extractPhones(page.content));
    if (page.rawHtml) allJsonLd.push(...extractJsonLd(page.rawHtml));
  }

  // Deduplicate
  const uniqueEmails = [...new Set(allEmails)];
  const uniqueProfiles = [...new Set(allLinkedInProfiles)];
  const uniqueCompanies = [...new Set(allLinkedInCompanies)];
  const uniquePhones = [...new Set(allPhones)];

  // Map to sections by key pattern
  for (const s of sections) {
    const kl = s.key.toLowerCase();
    const ll = s.label.toLowerCase();

    if (/email/.test(kl) || /email/.test(ll)) {
      if (uniqueEmails.length > 0) {
        result[s.key] = { value: uniqueEmails[0], confidence: 0.82, sourceUrl: pages[0]?.url };
      }
    } else if (/linkedin/.test(kl) || /linkedin/.test(ll)) {
      if (/company|firm|org/.test(kl) || /company|firm|org/.test(ll)) {
        if (uniqueCompanies.length > 0) {
          result[s.key] = { value: uniqueCompanies[0], confidence: 0.88, sourceUrl: pages[0]?.url };
        }
      } else {
        if (uniqueProfiles.length > 0) {
          result[s.key] = { value: uniqueProfiles[0], confidence: 0.88, sourceUrl: pages[0]?.url };
        }
      }
    } else if (/phone|tel/.test(kl) || /phone|tel/.test(ll)) {
      if (uniquePhones.length > 0) {
        result[s.key] = { value: uniquePhones[0], confidence: 0.80, sourceUrl: pages[0]?.url };
      }
    } else if ((/name/.test(kl) || /name/.test(ll)) && allJsonLd.length > 0) {
      const person = allJsonLd.find(j => j.name);
      if (person?.name) {
        result[s.key] = { value: person.name, confidence: 0.85, sourceUrl: pages[0]?.url };
      }
    } else if ((/title|role|position/.test(kl) || /title|role|position/.test(ll)) && allJsonLd.length > 0) {
      const person = allJsonLd.find(j => j.jobTitle);
      if (person?.jobTitle) {
        result[s.key] = { value: person.jobTitle, confidence: 0.85, sourceUrl: pages[0]?.url };
      }
    }
  }

  return result;
}

/** Merge two FieldResultMaps, keeping the higher-confidence value per field. */
function mergeFieldResults(base: FieldResultMap, incoming: FieldResultMap): FieldResultMap {
  const merged = { ...base };
  for (const [key, inc] of Object.entries(incoming)) {
    const existing = merged[key];
    if (!inc.value?.trim()) continue;
    if (!existing?.value?.trim()) { merged[key] = inc; continue; }
    if (inc.confidence > (existing.confidence ?? 0)) { merged[key] = inc; }
  }
  return merged;
}

/** Convert FieldResultMap to plain string Record for LLM prompts. */
function fieldMapToStrings(map: FieldResultMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) out[k] = v.value ?? "";
  return out;
}

/** Check if all critical fields (email, name, title of decision maker) are filled. */
function criticalFieldsFilled(sections: AgentSection[], fieldResults: FieldResultMap): boolean {
  const critical = sections.filter(s =>
    /email|name|title|role|position/i.test(s.key + " " + s.label) &&
    /decision.?maker|dm\d|contact|person/i.test(s.key),
  );
  if (critical.length === 0) {
    // No explicitly critical fields — check all
    return sections.every(s => (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD);
  }
  return critical.every(s => (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD);
}

// ---------------------------------------------------------------------------
// Phase 3 — Targeted LLM extraction
// ---------------------------------------------------------------------------

async function llmExtractFields(
  pages: FetchedPage[],
  sections: AgentSection[],
  systemPrompt: string,
  existingData: Record<string, string>,
): Promise<Record<string, string>> {
  // Only extract fields that are still empty
  const missingKeys = sections.filter(s => !existingData[s.key]?.trim()).map(s => s.key);
  if (missingKeys.length === 0) return existingData;

  const missingSections = sections.filter(s => missingKeys.includes(s.key));

  // Build schema for missing fields only
  const props: Record<string, { type: string; description: string }> = {};
  for (const s of missingSections) {
    props[s.key] = { type: "string", description: `${s.label}: ${s.desc}` };
  }

  // Combine the best 3 pages into one context block
  const sortedPages = [...pages].sort((a, b) => scoreUrl(b.url) - scoreUrl(a.url));
  const contextChunks = sortedPages.slice(0, 3).map(p =>
    `--- Page: ${p.url} ---\n${p.content.slice(0, 8000)}`
  );
  const combinedContent = contextChunks.join("\n\n");

  const alreadyFoundBrief = Object.entries(existingData)
    .filter(([, v]) => v?.trim())
    .map(([k, v]) => `${k}: "${v.slice(0, 60)}"`)
    .join(" | ");

  const userMsg = `${systemPrompt}

Already found: ${alreadyFoundBrief || "(nothing yet)"}

Page content:
${combinedContent}

Extract ONLY these missing fields: ${missingSections.map(s => `${s.key} (${s.label})`).join(", ")}
For fields that cannot be determined from the content, return an empty string "".
Return ONLY valid JSON with keys: ${missingKeys.join(", ")}`;

  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: userMsg }],
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "field_extraction",
          strict: true,
          schema: {
            type: "object",
            properties: props,
            required: missingKeys,
            additionalProperties: false,
          },
        },
      },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");
    const result = { ...existingData };
    for (const s of missingSections) {
      const val = String(parsed[s.key] ?? "").trim();
      if (val) result[s.key] = val;
    }
    return result;
  } catch (err) {
    console.warn("[superScraper] LLM extraction failed (non-fatal):", err instanceof Error ? err.message : String(err));
    return existingData;
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — Agentic planner
// ---------------------------------------------------------------------------

type AgentAction =
  | { action: "fetch_url"; target: string; reason: string }
  | { action: "web_search"; query: string; reason: string }
  | { action: "done"; reason: string };

async function planNextAction(
  companyName: string,
  websiteUrl: string,
  objective: string,
  sections: AgentSection[],
  data: Record<string, string>,
  visitedUrls: Set<string>,
  availableLinks: string[],
  hopsUsed: number,
  maxHops: number,
  webSearchedFields: Set<string>,
): Promise<AgentAction> {
  const weakFields = sections.filter(s => !data[s.key]?.trim());
  if (weakFields.length === 0 || hopsUsed >= maxHops) {
    return { action: "done", reason: weakFields.length === 0 ? "All fields filled" : "Max hops reached" };
  }

  const foundBrief = sections
    .filter(s => data[s.key]?.trim())
    .map(s => `${s.label}: "${data[s.key].slice(0, 60)}"`)
    .join(" | ") || "(none yet)";
  const missingBrief = weakFields.map(s => s.label).join(", ");
  const visitedList = [...visitedUrls].slice(-8).join("\n  ");
  const linkList = availableLinks.slice(0, 15).join("\n  ");
  const searchedList = webSearchedFields.size > 0 ? Array.from(webSearchedFields).join(", ") : "(none)";
  const hopsLeft = maxHops - hopsUsed;

  const systemMsg = `You are a B2B data extraction agent. Decide the single best next action: fetch_url, web_search, or done.
RULES:
- Never revisit a URL already in the visited list.
- Prefer internal company pages over external directories.
- Use web_search when no more useful internal pages exist.
- Use targeted search queries: "COMPANY_NAME" CEO email, "COMPANY_NAME" founder LinkedIn.
- Return ONLY valid JSON: {"action":"fetch_url"|"web_search"|"done","target":"full URL or null","query":"search query or null","reason":"one sentence"}`;

  const userMsg = `Company: ${companyName}
Website: ${websiteUrl}
Objective: ${objective}

Found: ${foundBrief}
Missing: ${missingBrief}

Visited:
  ${visitedList || "(none)"}

Available links:
  ${linkList || "(none — use web_search)"}

Already searched: ${searchedList}
Hops used: ${hopsUsed}/${maxHops} (${hopsLeft} remaining)`;

  try {
    const response = await queuedLLMCall({
      messages: [
        { role: "system", content: systemMsg },
        { role: "user", content: userMsg },
      ],
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "agent_action",
          strict: true,
          schema: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["fetch_url", "web_search", "done"] },
              target: { type: ["string", "null"] },
              query: { type: ["string", "null"] },
              reason: { type: "string" },
            },
            required: ["action", "target", "query", "reason"],
            additionalProperties: false,
          },
        },
      },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");

    if (parsed.action === "fetch_url" && parsed.target) {
      if (visitedUrls.has(parsed.target)) {
        return {
          action: "web_search",
          query: `"${companyName}" ${weakFields[0]?.label ?? "contact"} email`,
          reason: "Chosen URL already visited — falling back to web search",
        };
      }
      return { action: "fetch_url", target: parsed.target, reason: parsed.reason ?? "" };
    }
    if (parsed.action === "web_search") {
      const query = parsed.query?.trim() || `"${companyName}" ${weakFields[0]?.label ?? "contact"}`;
      return { action: "web_search", query, reason: parsed.reason ?? "" };
    }
    return { action: "done", reason: parsed.reason ?? "LLM decided done" };
  } catch {
    return { action: "done", reason: "Planning error — stopping safely" };
  }
}

/** Perform a web search via Jina Search API. */
async function searchWeb(query: string, maxResults = 5): Promise<Array<{ url: string; title: string; snippet: string }>> {
  try {
    const encoded = encodeURIComponent(query);
    const r = await fetchViaJina(`https://s.jina.ai/${encoded}`);
    if (!r?.success || !r.content) return [];

    // Parse Jina search results (markdown format: numbered list with URL and snippet)
    const results: Array<{ url: string; title: string; snippet: string }> = [];
    const lines = r.content.split("\n");
    let current: { url: string; title: string; snippet: string } | null = null;

    for (const line of lines) {
      // Jina search returns: "1. [Title](URL)\nSnippet..."
      const titleMatch = line.match(/^\d+\.\s+\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/);
      if (titleMatch) {
        if (current) results.push(current);
        current = { title: titleMatch[1], url: titleMatch[2], snippet: "" };
      } else if (current && line.trim()) {
        current.snippet += (current.snippet ? " " : "") + line.trim();
      }
    }
    if (current) results.push(current);

    return results.slice(0, maxResults);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Sitemap fetcher
// ---------------------------------------------------------------------------

async function fetchSitemapUrls(baseUrl: string, limit = 30): Promise<string[]> {
  let origin = "";
  try { origin = new URL(baseUrl).origin; } catch { return []; }

  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  for (const sitemapUrl of candidates) {
    try {
      const r = await fetchViaJina(sitemapUrl);
      if (!r?.success || !r.content) continue;
      const locs = r.content.match(/<loc>([^<]+)<\/loc>/gi) ?? [];
      const urls: string[] = [];
      for (const loc of locs) {
        const u = loc.replace(/<\/?loc>/gi, "").trim();
        if (u.startsWith("http") && !/\.(jpg|png|gif|pdf|zip|css|js)$/i.test(u)) {
          urls.push(u);
          if (urls.length >= limit) break;
        }
      }
      if (urls.length > 0) return urls;
    } catch { /* non-fatal */ }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Super Scraper — drop-in replacement for scrapeUrl() in routers.ts.
 *
 * Activates via USE_SUPER_SCRAPER=true environment variable.
 * Falls back gracefully at every phase — a failure in Phase 4 never
 * prevents Phase 5 from running.
 */
export async function scrapeUrlSuper(
  url: string,
  objective: string,
  sections: AgentSection[],
  systemPrompt: string,
  _maxHops = 5, // Ignored — super scraper uses its own phase-based hop budget
  isCancelled?: () => boolean,
): Promise<AgentScrapeResult> {
  const startMs = Date.now();
  const companyName = (() => { try { return new URL(url).hostname.replace(/^www\./, "").split(".")[0]; } catch { return url; } })();

  console.log(`[superScraper] 🚀 Starting: ${companyName} (${url})`);

  const visitedUrls = new Set<string>();
  const allPages: FetchedPage[] = [];
  let fieldResults: FieldResultMap = {};

  // ── PHASE 1: FAST DISCOVERY & PARALLEL FETCH ─────────────────────────────

  if (isCancelled?.()) throw new Error("JOB_CANCELLED");
  console.log(`[superScraper] Phase 1: URL discovery`);

  // 1a. Fetch homepage first
  const homepage = await fetchPage(url, isCancelled);
  if (homepage) {
    visitedUrls.add(url);
    allPages.push(homepage);
  }

  // 1b. Discover additional URLs from multiple sources
  const [sitemapUrls, standardUrls] = await Promise.all([
    fetchSitemapUrls(url, 30),
    Promise.resolve(generateStandardURLs(url).map(d => d.url)),
  ]);

  const discoveredUrls = homepage
    ? discoverRelevantURLs(homepage.content, url, {
        maxTeamPages: 5, maxPortfolioPages: 3, maxAboutPages: 3, includeOther: false,
      }).map(d => d.url)
    : [];

  // Heuristic team page candidates
  const teamCandidates = ["/team", "/about/team", "/our-team", "/people", "/leadership", "/management", "/founders", "/partners", "/staff"].map(p => {
    try { return new URL(p, url).href; } catch { return null; }
  }).filter((u): u is string => !!u);

  const allCandidates = [
    ...teamCandidates,
    ...discoveredUrls,
    ...(homepage?.links ?? []),
    ...sitemapUrls,
    ...standardUrls,
  ];

  const urlsToFetch = prioritiseUrls(allCandidates, url, MAX_PARALLEL_PAGES)
    .filter(u => !visitedUrls.has(u))
    .slice(0, MAX_PARALLEL_PAGES - 1);

  console.log(`[superScraper] Phase 1: fetching ${urlsToFetch.length} additional pages in parallel`);

  // Parallel fetch in batches
  for (let i = 0; i < urlsToFetch.length; i += FETCH_CONCURRENCY) {
    if (isCancelled?.()) throw new Error("JOB_CANCELLED");
    const batch = urlsToFetch.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(pageUrl => fetchPage(pageUrl, isCancelled)),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        visitedUrls.add(r.value.url);
        allPages.push(r.value);
      }
    }
  }

  // 1c. Deep team profile traversal — detect individual bio links from team pages
  const teamPages = allPages.filter(p => scoreUrl(p.url) >= 90 || /\/(team|people|leadership|partners)/.test(p.url));
  for (const teamPage of teamPages.slice(0, 2)) {
    if (!teamPage.rawHtml || isCancelled?.()) continue;
    try {
      const profileLinks = detectTeamMemberProfileLinks(teamPage.rawHtml, teamPage.url, { maxProfiles: MAX_DEEP_PROFILES });
      if (profileLinks.length > 0) {
        console.log(`[superScraper] Deep profiles: ${profileLinks.length} individual bios on ${teamPage.url}`);
        const profileUrls = profileLinks.map(p => p.profileUrl).filter(u => !visitedUrls.has(u)).slice(0, MAX_DEEP_PROFILES);
        const profileResults = await Promise.allSettled(
          profileUrls.map(profileUrl => fetchPage(profileUrl, isCancelled)),
        );
        for (const pr of profileResults) {
          if (pr.status === "fulfilled" && pr.value) {
            visitedUrls.add(pr.value.url);
            allPages.push(pr.value);
          }
        }
      }
    } catch (err) {
      console.warn(`[superScraper] Deep profile detection failed (non-fatal):`, err);
    }
  }

  // 1d. Multi-region/stage team page detection
  const allLinks = allPages.flatMap(p => p.links);
  const regionPattern = /\/(us|uk|europe|asia|apac|latam|emea|seed|growth|early|late)[-_]?(team|stage|region)/i;
  const regionLinks = allLinks.filter(u => {
    try { return regionPattern.test(new URL(u).pathname) && !visitedUrls.has(u); } catch { return false; }
  });
  for (const regionUrl of regionLinks.slice(0, 3)) {
    if (isCancelled?.()) break;
    const rPage = await fetchPage(regionUrl, isCancelled);
    if (rPage) { visitedUrls.add(regionUrl); allPages.push(rPage); }
  }

  console.log(`[superScraper] Phase 1 complete: ${allPages.length} pages fetched`);

  // ── PHASE 2: DETERMINISTIC EXTRACTION ────────────────────────────────────

  if (isCancelled?.()) throw new Error("JOB_CANCELLED");
  console.log(`[superScraper] Phase 2: Deterministic extraction`);

  const deterministicResults = deterministicExtract(allPages, sections);
  fieldResults = mergeFieldResults(fieldResults, deterministicResults);

  const phase2Filled = sections.filter(s => (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD).length;
  console.log(`[superScraper] Phase 2 complete: ${phase2Filled}/${sections.length} fields confident`);

  // ── ASSESSMENT GATE 1 ─────────────────────────────────────────────────────
  let data = fieldMapToStrings(fieldResults);

  if (!criticalFieldsFilled(sections, fieldResults)) {

    // ── PHASE 3: TARGETED LLM EXTRACTION ─────────────────────────────────────
    if (isCancelled?.()) throw new Error("JOB_CANCELLED");
    console.log(`[superScraper] Phase 3: Targeted LLM extraction`);

    try {
      data = await llmExtractFields(allPages, sections, systemPrompt, data);
      // Update fieldResults with LLM results (confidence 0.75 for LLM-extracted)
      for (const s of sections) {
        if (data[s.key]?.trim() && !(fieldResults[s.key]?.value?.trim())) {
          fieldResults[s.key] = { value: data[s.key], confidence: 0.75, sourceUrl: allPages[0]?.url };
        }
      }
    } catch (err) {
      console.warn(`[superScraper] Phase 3 failed (non-fatal):`, err);
    }

    const phase3Filled = sections.filter(s => (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD).length;
    console.log(`[superScraper] Phase 3 complete: ${phase3Filled}/${sections.length} fields confident`);

    // ── ASSESSMENT GATE 2 ───────────────────────────────────────────────────
    if (!criticalFieldsFilled(sections, fieldResults)) {

      // ── PHASE 4: AGENTIC ESCALATION ────────────────────────────────────────
      if (isCancelled?.()) throw new Error("JOB_CANCELLED");
      console.log(`[superScraper] Phase 4: Agentic escalation (max ${MAX_AGENT_HOPS} hops)`);

      let availableLinks = [...new Set(allPages.flatMap(p => p.links))].filter(u => !visitedUrls.has(u));
      const webSearchedFields = new Set<string>();
      let hopsUsed = 0;
      let lastFilledCount = sections.filter(s => data[s.key]?.trim()).length;
      let stallCount = 0;

      while (hopsUsed < MAX_AGENT_HOPS) {
        if (isCancelled?.()) throw new Error("JOB_CANCELLED");

        const plan = await planNextAction(
          companyName, url, objective, sections, data,
          visitedUrls, availableLinks, hopsUsed, MAX_AGENT_HOPS, webSearchedFields,
        );

        console.log(`[superScraper] Phase 4 [hop ${hopsUsed}/${MAX_AGENT_HOPS}]: ${plan.action} — ${plan.reason}`);

        if (plan.action === "done") break;

        if (plan.action === "fetch_url") {
          const fetched = await fetchPage(plan.target, isCancelled);
          if (!fetched) {
            availableLinks = availableLinks.filter(l => l !== plan.target);
            continue; // Don't count failed fetches as hops
          }
          hopsUsed++;
          visitedUrls.add(plan.target);
          allPages.push(fetched);
          availableLinks = [...new Set([...availableLinks, ...fetched.links])].filter(l => !visitedUrls.has(l));

          // LLM extraction on this page
          if (!isCancelled?.()) {
            try {
              data = await llmExtractFields([fetched], sections, systemPrompt, data);
            } catch { /* non-fatal */ }
          }

        } else if (plan.action === "web_search") {
          const searchResults = await searchWeb(plan.query, 5);
          if (searchResults.length === 0) continue;
          hopsUsed++;

          const candidates = searchResults.filter(r => !visitedUrls.has(r.url)).slice(0, 3);
          for (const result of candidates) {
            if (isCancelled?.()) throw new Error("JOB_CANCELLED");
            const fetched = await fetchPage(result.url, isCancelled);
            if (fetched) {
              visitedUrls.add(result.url);
              allPages.push(fetched);
              availableLinks = [...new Set([...availableLinks, ...fetched.links])].filter(l => !visitedUrls.has(l));
              if (!isCancelled?.()) {
                try {
                  data = await llmExtractFields([fetched], sections, systemPrompt, data);
                } catch { /* non-fatal */ }
              }
            } else {
              // Use snippet as fallback
              visitedUrls.add(result.url);
              const snippetPage: FetchedPage = { url: result.url, content: `${result.title}\n${result.snippet}`, links: [] };
              try {
                data = await llmExtractFields([snippetPage], sections, systemPrompt, data);
              } catch { /* non-fatal */ }
            }
            if (sections.every(s => data[s.key]?.trim())) break;
          }

          // Track searched field to avoid re-searching
          const weakest = sections.filter(s => !data[s.key]?.trim())[0];
          if (weakest) webSearchedFields.add(weakest.key);
        }

        // Diminishing-returns early-stop
        const currentFilled = sections.filter(s => data[s.key]?.trim()).length;
        if (currentFilled > lastFilledCount) {
          stallCount = 0;
        } else {
          stallCount++;
          if (stallCount >= 2) {
            console.log(`[superScraper] Phase 4: diminishing returns — stopping at hop ${hopsUsed}/${MAX_AGENT_HOPS}`);
            break;
          }
        }
        lastFilledCount = currentFilled;
      }

      const phase4Filled = sections.filter(s => data[s.key]?.trim()).length;
      console.log(`[superScraper] Phase 4 complete: ${phase4Filled}/${sections.length} fields filled`);
    } // end gate 2
  } // end gate 1

  // ── PHASE 5: FINAL LLM CONSOLIDATION ─────────────────────────────────────
  // One final pass combining all gathered content to fill any remaining gaps
  if (!isCancelled?.() && sections.some(s => !data[s.key]?.trim())) {
    console.log(`[superScraper] Phase 5: Final LLM consolidation`);
    try {
      data = await llmExtractFields(allPages, sections, systemPrompt, data);
    } catch (err) {
      console.warn(`[superScraper] Phase 5 failed (non-fatal):`, err);
    }
  }

  // ── BUILD FINAL RESULT ─────────────────────────────────────────────────────

  const emptyFields = sections.map(s => s.key).filter(k => !data[k] || data[k].trim() === "");
  const stats: ScrapeStats = {
    fieldsTotal: sections.length,
    fieldsFilled: sections.length - emptyFields.length,
    emptyFields,
  };

  const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(
    `[superScraper] ✅ Done: ${allPages.length} pages, ` +
    `${stats.fieldsFilled}/${sections.length} filled, ${durationSec}s`,
  );

  return { type: "profile", data, stats };
}
