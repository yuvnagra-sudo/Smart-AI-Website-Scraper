/**
 * Super Scraper Engine v2 — AI-Augmented Hybrid Escalation
 * ========================================================
 *
 * Merges the zero-cost speed of deterministic extraction with the deep
 * reasoning of an LLM agent loop. Uses model tiering (nano for cheap
 * extraction, mini for reasoning), per-field confidence thresholds,
 * LLM-powered URL discovery, and a validation layer to maximize data
 * quality while minimizing cost.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PHASE 1 — Smart Discovery & Parallel Fetch             Cost: ~$0.0001 │
 * │    Sitemap + homepage link collection                                   │
 * │    LLM URL picker (nano): ranks all candidate URLs by relevance        │
 * │    Parallel Jina/Puppeteer fetch of top 10 LLM-picked pages            │
 * │    Deep team profile link detection (detectTeamMemberProfileLinks)      │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  PHASE 2 — Deterministic Extraction                     Cost: $0.00    │
 * │    Regex: emails, phones, LinkedIn URLs                                 │
 * │    JSON-LD / Schema.org via cheerio                                     │
 * │    mailto: link extraction from raw HTML                                │
 * │    Per-field confidence scoring with adaptive thresholds                │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  ASSESSMENT GATE: per-field thresholds met?                             │
 * │    YES → skip to Phase 5                                                │
 * │    NO  → continue to Phase 3                                            │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  PHASE 3 — Targeted LLM Extraction (nano)               Cost: ~$0.0004 │
 * │    Single nano call on best 5 preprocessed pages                        │
 * │    Extracts only missing fields with structured JSON output             │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  ASSESSMENT GATE: per-field thresholds met?                             │
 * │    YES → skip to Phase 5                                                │
 * │    NO  → continue to Phase 4                                            │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  PHASE 4 — Smart Agentic Escalation (mini+nano)         Cost: ~$0.006  │
 * │    LLM planner (mini): fetch_url | web_search | done                    │
 * │    Query diversification (2-3 diverse searches per missing field)       │
 * │    Snippet-first evaluation (extract from snippets before fetching)     │
 * │    LLM extraction (nano) on fetched pages                               │
 * │    Cost budget cap (default $0.02 per company)                          │
 * │    Diminishing-returns early-stop                                       │
 * │    Hard cap: SUPER_SCRAPER_AGENT_HOPS (default: 4)                      │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  PHASE 5 — Validation + Final Consolidation             Cost: ~$0.0006 │
 * │    5a. LLM-as-Judge (nano): validates extracted data, flags errors      │
 * │    5b. Final nano pass to fill remaining gaps                           │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Model tiering: gpt-5.4-nano (5x cheaper) for extraction & validation,
 *                gpt-5.4-mini for Phase 4 agentic reasoning only.
 *
 * Activation: set USE_SUPER_SCRAPER=true in Railway environment variables.
 */

import * as cheerio from "cheerio";
import { fetchViaJina, fetchWebsiteContentHybrid } from "./jinaFetcher";
import { queuedLLMCall } from "./_core/llmQueue";
import { detectTeamMemberProfileLinks } from "./deepTeamProfileScraper";
import { generateStandardURLs, discoverRelevantURLs } from "./multiUrlDiscovery";
import { CONFIDENCE } from "./confidenceLevels";
import type { AgentSection, AgentScrapeResult, ScrapeStats, ScrapeDiagnostics } from "./agentScraper";

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
const CONFIDENCE_THRESHOLD = 0.50;

// ---------------------------------------------------------------------------
// Model tiering — nano for cheap extraction, mini for reasoning-heavy tasks
// ---------------------------------------------------------------------------

/** Cheap model for structured extraction, validation, URL picking. */
const MODEL_NANO = "gpt-5.4-nano";
/** Capable model for agentic reasoning (Phase 4 planning). */
const MODEL_MINI = "gpt-5.4-mini";

// ---------------------------------------------------------------------------
// Per-field confidence thresholds — different fields need different certainty
// ---------------------------------------------------------------------------

/** Get the confidence threshold for a given section key/label.
 *  Contact fields have a low quality floor (reject garbage, not gate phases).
 *  Name and title are the critical identity fields.
 *  Hunter + Apollo handle email/LinkedIn enrichment in Phase 6 separately. */
function getFieldThreshold(key: string, label: string): number {
  const kl = (key + " " + label).toLowerCase();
  // Contact fields — low threshold (quality floor, not phase gating)
  if (/email/.test(kl)) return 0.30;
  if (/phone|tel/.test(kl)) return 0.30;
  if (/linkedin/.test(kl)) return 0.25;
  if (/social|twitter|facebook|instagram/.test(kl)) return 0.0; // truly optional
  // Identity fields — these actually matter
  if (/\bname\b/.test(kl)) return 0.65;
  if (/title|role|position/.test(kl)) return 0.55;
  // Everything else
  if (/niche|focus|thesis|sector/.test(kl)) return 0.50;
  if (/portfolio|investment/.test(kl)) return 0.50;
  if (/description|overview/.test(kl)) return 0.45;
  return CONFIDENCE_THRESHOLD; // default fallback
}

/** Max LLM cost budget per company before Phase 4 stops escalating. */
const COST_BUDGET_PER_COMPANY = parseFloat(process.env.SUPER_COST_BUDGET ?? "0.02");

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

  try {
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

    // Filter out soft-404s and error pages (HTTP 200 but error content)
    if (isErrorPageContent(result.content)) {
      console.log(`[superScraper] Soft-404 detected, skipping: ${url}`);
      return null;
    }

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
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
          signal: AbortSignal.timeout(8000),
          redirect: "follow",
        });
        if (resp.ok) {
          const html = await resp.text();
          if (html.length > 500) rawHtml = html;
        }
      } catch { /* non-fatal */ }
    }

    return { url, content: result.content, rawHtml, links };
  } catch (err: unknown) {
    // Swallow 404s, network errors, and Axios ERR_BAD_REQUEST — return null so the
    // caller skips this URL without crashing the entire phase-1 parallel sweep.
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as any)?.code ?? "";
    const status = (err as any)?.response?.status ?? (err as any)?.status ?? 0;
    const silentCodes = ["ERR_BAD_REQUEST", "ECONNREFUSED", "ENOTFOUND", "ECONNRESET",
      "ETIMEDOUT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN", "ERR_SOCKET_CLOSED"];
    const silentStatuses = [404, 403, 410, 502, 503, 522, 525];
    if (silentStatuses.includes(status) || silentCodes.includes(code)) {
      return null; // expected — page down, cert expired, DNS fail, etc.
    }
    // One-line log only — never dump full error objects
    console.warn(`[superScraper] fetchPage error for ${url}: ${code || status || ""} ${msg.slice(0, 120)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deterministic extraction helpers (Phase 2)
// ---------------------------------------------------------------------------

/** Extract emails from HTML and markdown content. */
function extractEmails(content: string, rawHtml?: string): string[] {
  const emails = new Set<string>();
  const emailRegex = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

  // Only filter system/junk emails — keep generic forwarding emails
  // (info@, contact@, admin@ etc. may be the only way to reach someone)
  const JUNK_PREFIXES = /^(noreply|no-reply|donotreply|do-not-reply|webmaster|postmaster|mailer-daemon|bounce|daemon|unsubscribe)@/i;
  const JUNK_DOMAINS = /\.(png|jpg|gif|svg|css|js|woff|ico)$|@(example\.com|test\.com|localhost|placeholder\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|mailinator\.com|tempmail\.com)$/i;

  function isJunk(email: string): boolean {
    return JUNK_PREFIXES.test(email) || JUNK_DOMAINS.test(email);
  }

  // From markdown content
  for (const m of (content.match(emailRegex) ?? [])) {
    const lower = m.toLowerCase();
    if (!isJunk(lower)) emails.add(lower);
  }

  // From raw HTML — both mailto: links AND regex on full HTML text
  // This catches emails that Jina's markdown conversion strips out
  // (e.g. emails in footers, sidebars, JS-rendered contact sections)
  if (rawHtml) {
    const $ = cheerio.load(rawHtml);

    // mailto: links (highest reliability)
    $('a[href^="mailto:"]').each((_, el) => {
      const href = $(el).attr("href") ?? "";
      const email = href.replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase();
      if (email.match(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/) && !isJunk(email)) {
        emails.add(email);
      }
    });

    // Regex on full body text (catches emails in footers that Jina strips)
    const bodyText = $("body").text();
    for (const m of (bodyText.match(emailRegex) ?? [])) {
      const lower = m.toLowerCase();
      if (!isJunk(lower)) emails.add(lower);
    }

    // Also scan href attributes (some sites use href="mailto:..." without the mailto prefix properly)
    $("a[href*='@']").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      const match = href.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (match) {
        const lower = match[1].toLowerCase();
        if (!isJunk(lower)) emails.add(lower);
      }
    });
  }

  return Array.from(emails);
}

/** Extract LinkedIn profile/company URLs from content AND raw HTML. */
function extractLinkedInUrls(content: string, rawHtml?: string): { profiles: string[]; companies: string[] } {
  const profilePattern = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+\/?/g;
  const companyPattern = /https?:\/\/(?:www\.)?linkedin\.com\/company\/[a-zA-Z0-9_-]+\/?/g;
  const profiles = new Set(content.match(profilePattern) ?? []);
  const companies = new Set(content.match(companyPattern) ?? []);

  // Also scan raw HTML (catches links in footers/sidebars stripped by Jina)
  if (rawHtml) {
    for (const m of (rawHtml.match(profilePattern) ?? [])) profiles.add(m);
    for (const m of (rawHtml.match(companyPattern) ?? [])) companies.add(m);
  }

  return { profiles: [...profiles], companies: [...companies] };
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
function extractPhones(content: string, rawHtml?: string): string[] {
  const phonePattern = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
  // Scan both markdown content AND raw HTML body text
  let allText = content;
  if (rawHtml) {
    try {
      const $ = cheerio.load(rawHtml);
      allText += "\n" + $("body").text();
    } catch { /* non-fatal */ }
  }
  const matches = allText.match(phonePattern) ?? [];
  const filtered = matches.filter(m => {
    const digitsOnly = m.replace(/\D/g, "");
    if (digitsOnly.length < 7 || digitsOnly.length > 15) return false;
    if (/^\d{10,}$/.test(m.trim())) return false;
    return true;
  });
  return [...new Set(filtered)].slice(0, 5);
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
    const li = extractLinkedInUrls(page.content, page.rawHtml);
    allLinkedInProfiles.push(...li.profiles);
    allLinkedInCompanies.push(...li.companies);
    allPhones.push(...extractPhones(page.content, page.rawHtml));
    if (page.rawHtml) allJsonLd.push(...extractJsonLd(page.rawHtml));
  }

  // Deduplicate
  const uniqueEmails = [...new Set(allEmails)];
  const uniqueProfiles = [...new Set(allLinkedInProfiles)];
  const uniqueCompanies = [...new Set(allLinkedInCompanies)];
  const uniquePhones = [...new Set(allPhones)];

  // Map to sections by key pattern — broadened matching to catch template
  // section names like "key_decision_makers", "contact_info", "key_contact"
  for (const s of sections) {
    const kl = s.key.toLowerCase();
    const ll = s.label.toLowerCase();
    const combined = kl + " " + ll;

    // Email / contact detail fields — gets emails + phone
    if (/email|contact.?info|contact.?location|contact.?detail/i.test(combined)) {
      const contactParts: string[] = [];
      if (uniqueEmails.length > 0) contactParts.push(...uniqueEmails.slice(0, 3));
      if (uniquePhones.length > 0) contactParts.push(uniquePhones[0]);
      if (contactParts.length > 0) {
        result[s.key] = { value: contactParts.join("; "), confidence: CONFIDENCE.EXTRACTED, sourceUrl: pages[0]?.url };
      }
    }
    // Decision maker fields — ONLY gets name + title from JSON-LD, never raw emails
    else if (/decision.?maker|key.?contact|primary.?contact|dm\d/i.test(combined)) {
      if (allJsonLd.length > 0) {
        const person = allJsonLd.find(j => j.name);
        if (person?.name) {
          const parts = [person.name];
          if (person.jobTitle) parts.push(person.jobTitle);
          result[s.key] = { value: parts.join(", "), confidence: CONFIDENCE.EXTRACTED, sourceUrl: pages[0]?.url };
        }
      }
      // Don't fall back to email here — let the LLM handle this field
    }
    // LinkedIn fields
    else if (/linkedin/.test(combined)) {
      if (/company|firm|org/.test(combined)) {
        if (uniqueCompanies.length > 0) {
          result[s.key] = { value: uniqueCompanies[0], confidence: CONFIDENCE.VERIFIED, sourceUrl: pages[0]?.url };
        }
      } else {
        if (uniqueProfiles.length > 0) {
          result[s.key] = { value: uniqueProfiles[0], confidence: CONFIDENCE.VERIFIED, sourceUrl: pages[0]?.url };
        }
      }
    }
    // Phone fields
    else if (/phone|tel/.test(combined)) {
      if (uniquePhones.length > 0) {
        result[s.key] = { value: uniquePhones[0], confidence: CONFIDENCE.EXTRACTED, sourceUrl: pages[0]?.url };
      }
    }
    // Name fields (from JSON-LD)
    else if ((/\bname\b/.test(kl) || /\bname\b/.test(ll)) && allJsonLd.length > 0) {
      const person = allJsonLd.find(j => j.name);
      if (person?.name) {
        result[s.key] = { value: person.name, confidence: CONFIDENCE.EXTRACTED, sourceUrl: pages[0]?.url };
      }
    }
    // Title/role fields (from JSON-LD)
    else if ((/title|role|position/.test(kl) || /title|role|position/.test(ll)) && allJsonLd.length > 0) {
      const person = allJsonLd.find(j => j.jobTitle);
      if (person?.jobTitle) {
        result[s.key] = { value: person.jobTitle, confidence: CONFIDENCE.EXTRACTED, sourceUrl: pages[0]?.url };
      }
    }
    // Qualification / notes / fit fields — leave for LLM (no deterministic extraction)
    // Location, hours, services, etc. — also leave for LLM
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

/** Check if critical fields are filled using per-field thresholds.
 *  Only name is truly critical — we want partial results (name + title)
 *  even without email/LinkedIn. */
function criticalFieldsFilled(sections: AgentSection[], fieldResults: FieldResultMap): boolean {
  const critical = sections.filter(s =>
    /\bname\b|title|role|position/i.test(s.key + " " + s.label),
  );
  const toCheck = critical.length > 0 ? critical : sections;
  return toCheck.every(s => {
    const threshold = getFieldThreshold(s.key, s.label);
    return (fieldResults[s.key]?.confidence ?? 0) >= threshold;
  });
}

/** Return section keys that are still below their per-field confidence threshold.
 *  Email, LinkedIn, phone, and social profiles are excluded — they are nice-to-haves,
 *  not worth burning expensive phases to chase down. */
function missingFields(sections: AgentSection[], fieldResults: FieldResultMap): AgentSection[] {
  return sections.filter(s => {
    const kl = (s.key + " " + s.label).toLowerCase();
    // Skip contact/social fields — they're bonuses, not requirements
    if (/email|linkedin|phone|tel|social|twitter|facebook|instagram/.test(kl)) return false;
    const threshold = getFieldThreshold(s.key, s.label);
    return (fieldResults[s.key]?.confidence ?? 0) < threshold;
  });
}

// ---------------------------------------------------------------------------
// Phase 3 — Targeted LLM extraction
// ---------------------------------------------------------------------------

async function llmExtractFields(
  pages: FetchedPage[],
  sections: AgentSection[],
  systemPrompt: string,
  existingData: Record<string, string>,
  model: string = MODEL_NANO,
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

  // Combine the best 5 pages with preprocessed content for denser context
  const sortedPages = [...pages].sort((a, b) => scoreUrl(b.url) - scoreUrl(a.url));
  const contextChunks = sortedPages.slice(0, 5).map(p =>
    `--- Page: ${p.url} ---\n${preprocessContent(p.content).slice(0, 6000)}`
  );
  const combinedContent = contextChunks.join("\n\n");

  // Skip LLM if pages don't have usable content
  const usablePages = pages.filter(p => hasUsableContent(p.content));
  if (usablePages.length === 0) {
    console.log("[superScraper] No pages with usable content — skipping LLM extraction");
    return existingData;
  }

  const alreadyFoundBrief = Object.entries(existingData)
    .filter(([, v]) => v?.trim())
    .map(([k, v]) => `${k}: "${v.slice(0, 60)}"`)
    .join(" | ");

  // Build field guide with descriptions so the LLM knows what each field expects
  const fieldGuide = missingSections.map((s, i) =>
    `${i + 1}. ${s.key} (${s.label}): ${s.desc}`
  ).join("\n");

  // Build example output
  const exampleObj: Record<string, string> = {};
  for (const s of missingSections.slice(0, 2)) {
    exampleObj[s.key] = `[extracted ${s.label.toLowerCase()} from page]`;
  }
  const exampleJson = JSON.stringify(exampleObj, null, 2);

  const userMsg = `${systemPrompt}

FIELDS TO EXTRACT (read each description carefully):
${fieldGuide}

FIELD TYPES:
- Data fields (names, emails, phones, LinkedIn): Extract directly from page content. Return "" if not visible on the page.
- Analysis/judgment fields (fit, need, signal, competitor, qualification): Reason about what the page content IMPLIES about this company. Use evidence from the page to make a judgment call. It is OK to infer — just cite what you observed (e.g. "Uses Odoo eCommerce based on footer tag" or "No IT services mentioned; appears to be a retail florist"). For these fields, a well-reasoned assessment is better than an empty string. Only return "" if the page content is truly too thin to form any judgment.

FORMATTING RULES:
- Return plain text values only. Do NOT use markdown links like [text](url).
- Do NOT include HTML tags, URL encoding (%C3%A9), or HTML entities (&amp;).
- For person/name fields: return the person's full name and title (e.g. "Jane Doe, CEO"). Do NOT put email addresses in name fields.
- For contact/email fields: return email addresses and phone numbers as plain text (e.g. "jane@company.com; +1 555-1234").
- For data fields: if a field cannot be determined from the content, return an empty string "". Do NOT guess or hallucinate.
- For analysis fields: provide a brief, evidence-based assessment. Be specific — cite what you observed on the page.
- Ignore navigation menus, cookie banners, footer boilerplate, and third-party content.

Already found: ${alreadyFoundBrief || "(nothing yet)"}

Page content:
${combinedContent}

Example output format:
${exampleJson}

Return ONLY valid JSON with keys: ${missingKeys.join(", ")}`;

  try {
    const response = await queuedLLMCall({
      model,
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
      const val = cleanFieldValue(String(parsed[s.key] ?? "").trim());
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
      model: MODEL_MINI, // Phase 4 needs reasoning — use the capable model
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
// LLM-powered URL picker — replaces heuristic scoreUrl() for Phase 1
// ---------------------------------------------------------------------------

/**
 * Feed a list of URLs (from sitemap + homepage links) to a cheap nano call.
 * The LLM reads the URL paths and anchor text to pick the most relevant pages
 * for B2B contact extraction — catching non-standard paths that regex misses.
 *
 * Cost: ~$0.0001 (URL list is ~500-1500 tokens, tiny output).
 * Falls back to heuristic scoring if the LLM call fails.
 */
async function llmPickUrls(
  allUrls: Array<{ url: string; text?: string }>,
  companyName: string,
  baseUrl: string,
  maxPick: number,
): Promise<string[]> {
  if (allUrls.length === 0) return [];
  // If very few URLs, no point asking LLM — just return them all
  if (allUrls.length <= maxPick) return allUrls.map(u => u.url);

  // Build compact URL list for the LLM (path + anchor text)
  let baseDomain = "";
  try { baseDomain = new URL(baseUrl).hostname; } catch { /* ignore */ }

  const urlLines = allUrls.slice(0, 200).map((u, i) => {
    try {
      const parsed = new URL(u.url);
      const path = parsed.pathname + (parsed.search || "");
      const host = parsed.hostname !== baseDomain ? ` [${parsed.hostname}]` : "";
      const label = u.text ? ` — "${u.text.slice(0, 60)}"` : "";
      return `${i + 1}. ${path}${host}${label}`;
    } catch { return `${i + 1}. ${u.url}`; }
  }).join("\n");

  try {
    const response = await queuedLLMCall({
      model: MODEL_NANO,
      messages: [{
        role: "user",
        content: `You are picking the most useful pages to scrape from a company website for B2B lead extraction.

Company: ${companyName}
Website: ${baseUrl}

Available pages:
${urlLines}

Pick the ${maxPick} pages most likely to contain:
1. Team/leadership bios with names, titles, and emails
2. Contact information (emails, phone numbers)
3. Portfolio/investments/clients
4. Company description and focus areas

Return ONLY a JSON array of the page numbers (1-indexed) you'd pick, ranked by priority. Example: [3, 7, 1, 12, 5]`,
      }],
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "url_picks",
          strict: true,
          schema: {
            type: "object",
            properties: {
              picks: { type: "array", items: { type: "number" }, description: "1-indexed page numbers, ranked by priority" },
            },
            required: ["picks"],
            additionalProperties: false,
          },
        },
      },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");
    const picks: number[] = Array.isArray(parsed.picks) ? parsed.picks : [];

    // Map picks back to URLs (1-indexed → 0-indexed)
    const picked = picks
      .filter(n => typeof n === "number" && n >= 1 && n <= allUrls.length)
      .map(n => allUrls[n - 1].url)
      .slice(0, maxPick);

    if (picked.length > 0) {
      console.log(`[superScraper] LLM URL picker: selected ${picked.length} pages from ${allUrls.length} candidates`);
      return picked;
    }
  } catch (err) {
    console.warn(`[superScraper] LLM URL picker failed (falling back to heuristics):`, err instanceof Error ? err.message : String(err));
  }

  // Fallback: heuristic scoring
  return prioritiseUrls(allUrls.map(u => u.url), baseUrl, maxPick);
}

// ---------------------------------------------------------------------------
// Content preprocessing — strip boilerplate for denser LLM context
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Content quality gate — skip LLM on empty/error pages
// ---------------------------------------------------------------------------

/** Check if page content has enough meaningful text to justify an LLM call. */
function hasUsableContent(content: string): boolean {
  const words = content.split(/\s+/).filter(w => w.length > 2);
  return words.length >= 20;
}

/** Detect soft-404s and error pages that returned HTTP 200 but have error content. */
function isErrorPageContent(content: string): boolean {
  const lower = content.toLowerCase();
  const signals = [
    "page not found", "404 not found", "this page doesn't exist",
    "does not exist", "no longer available", "page has been removed",
    "we couldn't find", "the page you requested",
    "parked domain", "this domain is for sale", "buy this domain",
    "coming soon", "under construction", "website expired", "account suspended",
  ];
  // Short content + error signal = likely error page
  if (content.length < 500) {
    return signals.some(s => lower.includes(s));
  }
  // Longer content but title/first paragraph is an error
  const firstChunk = lower.slice(0, 300);
  return signals.some(s => firstChunk.includes(s));
}

// ---------------------------------------------------------------------------
// Post-processing cleanup — strip markdown/HTML artifacts from LLM output
// ---------------------------------------------------------------------------

/** Clean a single field value: strip markdown links, URL encoding, HTML entities. */
function cleanFieldValue(value: string): string {
  if (!value) return value;
  let v = value;
  // Strip markdown links: [text](url) → text
  v = v.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Decode URL encoding: %C3%A9 → é
  try { v = decodeURIComponent(v); } catch { /* invalid encoding, leave as-is */ }
  // Strip residual HTML tags
  v = v.replace(/<[^>]+>/g, "");
  // Decode common HTML entities
  v = v.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  // Normalize whitespace
  v = v.replace(/\s+/g, " ").trim();
  return v;
}

/** Clean all values in an extraction result. */
function cleanExtractedData(data: Record<string, string>): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    cleaned[k] = cleanFieldValue(v);
  }
  return cleaned;
}

/** Strip nav, footer, cookie banners, and repeated boilerplate from markdown content. */
function preprocessContent(content: string): string {
  const lines = content.split("\n");
  const filtered: string[] = [];
  let skipSection = false;

  for (const line of lines) {
    const lower = line.toLowerCase().trim();
    // Skip common boilerplate sections
    if (/^#{1,3}\s*(cookie|privacy|terms|footer|navigation|menu|sidebar|subscribe|newsletter)/i.test(line)) {
      skipSection = true;
      continue;
    }
    // Resume on next heading
    if (skipSection && /^#{1,3}\s/.test(line)) {
      skipSection = false;
    }
    if (skipSection) continue;
    // Skip short lines that are just navigation links
    if (lower.length < 5 && /^[\s|•·-]*$/.test(lower)) continue;
    // Skip cookie consent lines
    if (/cookie|gdpr|consent|privacy policy|terms of (use|service)/i.test(lower) && lower.length < 100) continue;

    filtered.push(line);
  }
  return filtered.join("\n");
}

// ---------------------------------------------------------------------------
// LLM-as-Judge validation — cheap nano call to catch bad extractions
// ---------------------------------------------------------------------------

/**
 * Validate extracted data with a nano LLM call. Input is tiny (~200 tokens)
 * since we only send the extracted fields, not page content.
 *
 * Returns a map of field keys to validation notes. Empty map = all OK.
 * Cost: ~$0.0002 per call.
 */
async function validateExtraction(
  data: Record<string, string>,
  sections: AgentSection[],
  companyName: string,
  websiteUrl: string,
): Promise<{ valid: boolean; corrections: Record<string, string> }> {
  const filledEntries = sections
    .filter(s => data[s.key]?.trim())
    .map(s => `- ${s.label} (${s.key}): "${data[s.key].slice(0, 120)}"`)
    .join("\n");

  if (!filledEntries) return { valid: true, corrections: {} };

  try {
    const response = await queuedLLMCall({
      model: MODEL_NANO,
      messages: [{
        role: "user",
        content: `Review this extracted data for ${companyName} (${websiteUrl}). Flag any fields that look wrong, implausible, or likely belong to a different entity.

Extracted fields:
${filledEntries}

IMPORTANT: Some fields contain analytical assessments (fit analysis, service needs, competitor signals, qualifications). These are subjective judgments by nature — only flag them as wrong if they clearly contradict the page content or contain fabricated facts. Do NOT remove them just because they express an opinion or inference.

For each problematic field, provide a corrected value or "REMOVE" if the data is wrong and should be cleared. If everything looks correct, return an empty corrections object.`,
      }],
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "validation_result",
          strict: true,
          schema: {
            type: "object",
            properties: {
              valid: { type: "boolean", description: "True if all fields look correct" },
              corrections: {
                type: "array",
                description: "List of field corrections. Empty array if everything is correct.",
                items: {
                  type: "object",
                  properties: {
                    field: { type: "string", description: "The field key to correct" },
                    value: { type: "string", description: "Corrected value, or REMOVE to clear" },
                  },
                  required: ["field", "value"],
                  additionalProperties: false,
                },
              },
            },
            required: ["valid", "corrections"],
            additionalProperties: false,
          },
        },
      },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");
    // Convert corrections array [{field, value}] to object {field: value}
    const corrections: Record<string, string> = {};
    if (Array.isArray(parsed.corrections)) {
      for (const c of parsed.corrections) {
        if (c.field && c.value) corrections[c.field] = c.value;
      }
    }
    return {
      valid: parsed.valid !== false,
      corrections,
    };
  } catch (err) {
    console.warn(`[superScraper] Validation failed (non-fatal):`, err instanceof Error ? err.message : String(err));
    return { valid: true, corrections: {} };
  }
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
/** Ensure a URL has a protocol prefix so new URL() never throws on bare domains. */
function normaliseUrl(raw: string): string {
  if (!raw) return raw;
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export async function scrapeUrlSuper(
  url: string,
  objective: string,
  sections: AgentSection[],
  systemPrompt: string,
  _maxHops = 5, // Ignored — super scraper uses its own phase-based hop budget
  isCancelled?: () => boolean,
): Promise<AgentScrapeResult> {
  // Normalise URL — bare domains like "acme.ca" become "https://acme.ca"
  url = normaliseUrl(url);
  const startMs = Date.now();
  const companyName = (() => { try { return new URL(url).hostname.replace(/^www\./, "").split(".")[0]; } catch { return url; } })();

  console.log(`[superScraper] 🚀 Starting: ${companyName} (${url})`);

  const visitedUrls = new Set<string>();
  const allPages: FetchedPage[] = [];
  let fieldResults: FieldResultMap = {};

  // Diagnostic tracking
  const diag: ScrapeDiagnostics = {
    pagesCollected: 0,
    pageUrls: [],
    pageSizes: [],
    phase2FieldsFilled: 0,
    phase3FieldsFilled: 0,
    phase4FieldsFilled: 0,
    phase5FieldsFilled: 0,
    failedUrls: [],
    softDeleted: [],
    topPagePreview: "",
  };

  // Track non-fatal failures for visibility (never silent)
  const extractionFailures: string[] = [];

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

  const discoveredLinks = homepage
    ? discoverRelevantURLs(homepage.content, url, {
        maxTeamPages: 5, maxPortfolioPages: 3, maxAboutPages: 3, includeOther: false,
      })
    : [];

  // Build unified URL list with anchor text for LLM picker
  const homepageLinks = homepage?.links ?? [];
  const allCandidateUrls: Array<{ url: string; text?: string }> = [];
  const seenUrls = new Set<string>();
  const addCandidate = (u: string, text?: string) => {
    try {
      const parsed = new URL(u);
      const norm = `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "") || parsed.origin;
      if (seenUrls.has(norm) || norm === url.replace(/\/$/, "")) return;
      // Filter out non-page URLs
      if (/\.(jpg|jpeg|png|gif|svg|pdf|zip|css|js|woff|ttf|ico)$/i.test(parsed.pathname)) return;
      // Filter to same domain
      let baseDomain = "";
      try { baseDomain = new URL(url).hostname; } catch { /* ignore */ }
      if (parsed.hostname !== baseDomain && !parsed.hostname.endsWith(`.${baseDomain}`)) return;
      seenUrls.add(norm);
      allCandidateUrls.push({ url: norm, text });
    } catch { /* skip */ }
  };

  // Add from all sources (with anchor text where available)
  for (const d of discoveredLinks) addCandidate(d.url, d.text);
  for (const u of sitemapUrls) addCandidate(u);
  for (const u of standardUrls) addCandidate(u);
  for (const u of homepageLinks) addCandidate(u);

  // LLM picks the best URLs to fetch (falls back to heuristic scoring)
  const pickedUrls = await llmPickUrls(allCandidateUrls, companyName, url, MAX_PARALLEL_PAGES - 1);
  const urlsToFetch = pickedUrls.filter(u => !visitedUrls.has(u)).slice(0, MAX_PARALLEL_PAGES - 1);

  console.log(`[superScraper] Phase 1: fetching ${urlsToFetch.length} additional pages (LLM-picked from ${allCandidateUrls.length} candidates)`);

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

  // Populate Phase 1 diagnostics
  diag.pagesCollected = allPages.length;
  diag.pageUrls = allPages.map(p => p.url);
  diag.pageSizes = allPages.map(p => p.content?.length ?? 0);
  // Failed URLs = visited but didn't produce a page (fetch errors, soft-404s, etc.)
  const successfulUrls = new Set(allPages.map(p => p.url));
  diag.failedUrls = [...visitedUrls].filter(u => !successfulUrls.has(u));
  const sortedForPreview = [...allPages].sort((a, b) => scoreUrl(b.url) - scoreUrl(a.url));
  diag.topPagePreview = sortedForPreview[0]?.content?.slice(0, 500) ?? "(no content)";

  // ── PHASE 2: DETERMINISTIC EXTRACTION ────────────────────────────────────

  if (isCancelled?.()) throw new Error("JOB_CANCELLED");
  console.log(`[superScraper] Phase 2: Deterministic extraction`);

  const deterministicResults = deterministicExtract(allPages, sections);
  fieldResults = mergeFieldResults(fieldResults, deterministicResults);

  const phase2Filled = sections.filter(s => (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD).length;
  diag.phase2FieldsFilled = phase2Filled;
  console.log(`[superScraper] Phase 2 complete: ${phase2Filled}/${sections.length} fields confident`);

  // ── ASSESSMENT GATE 1 ─────────────────────────────────────────────────────
  let data = fieldMapToStrings(fieldResults);

  if (!criticalFieldsFilled(sections, fieldResults)) {

    // ── PHASE 3: TARGETED LLM EXTRACTION ─────────────────────────────────────
    if (isCancelled?.()) throw new Error("JOB_CANCELLED");
    console.log(`[superScraper] Phase 3: Targeted LLM extraction`);

    try {
      // Use mini model when analytical/judgment fields are present (fit, need, signal, etc.)
      // Nano is too conservative for fields requiring business reasoning
      const missingInPhase3 = sections.filter(s => !data[s.key]?.trim());
      const hasAnalyticalFields = missingInPhase3.some(s => {
        const kl = (s.key + " " + s.label).toLowerCase();
        return !/email|phone|tel|linkedin|name|title|role|position/.test(kl);
      });
      const phase3Model = hasAnalyticalFields ? MODEL_MINI : MODEL_NANO;

      data = await llmExtractFields(allPages, sections, systemPrompt, data, phase3Model);
      // Update fieldResults with LLM results (confidence 0.75 for LLM-extracted)
      for (const s of sections) {
        if (data[s.key]?.trim() && !(fieldResults[s.key]?.value?.trim())) {
          fieldResults[s.key] = { value: data[s.key], confidence: CONFIDENCE.INFERRED, sourceUrl: allPages[0]?.url };
        }
      }
    } catch (err) {
      console.warn(`[superScraper] Phase 3 failed (non-fatal):`, err);
      extractionFailures.push(`Phase 3 LLM extraction: ${err instanceof Error ? err.message : String(err)}`);
    }

    const phase3Filled = sections.filter(s => (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD).length;
    diag.phase3FieldsFilled = phase3Filled;
    console.log(`[superScraper] Phase 3 complete: ${phase3Filled}/${sections.length} fields confident`);

    // Release page content to free memory — Phase 4 fetches fresh pages via fetchPage()
    for (const page of allPages) {
      page.content = "";
      page.rawHtml = undefined;
    }

    // ── ASSESSMENT GATE 2 ───────────────────────────────────────────────────
    if (!criticalFieldsFilled(sections, fieldResults)) {

      // ── PHASE 4: SMART AGENTIC ESCALATION ─────────────────────────────────
      if (isCancelled?.()) throw new Error("JOB_CANCELLED");
      console.log(`[superScraper] Phase 4: Agentic escalation (max ${MAX_AGENT_HOPS} hops, $${COST_BUDGET_PER_COMPANY} budget)`);

      let availableLinks = [...new Set(allPages.flatMap(p => p.links))].filter(u => !visitedUrls.has(u));
      const webSearchedFields = new Set<string>();
      let hopsUsed = 0;
      let lastFilledCount = sections.filter(s => data[s.key]?.trim()).length;
      let stallCount = 0;
      let phase4LlmCalls = 0;

      while (hopsUsed < MAX_AGENT_HOPS) {
        if (isCancelled?.()) throw new Error("JOB_CANCELLED");

        // Cost budget check — estimate LLM cost so far and stop if exceeded
        // Each LLM call ≈ $0.0014 (mini) or $0.0003 (nano). Phase 4 uses mini for planning + nano for extraction.
        const estimatedCost = phase4LlmCalls * 0.001; // conservative average
        if (estimatedCost > COST_BUDGET_PER_COMPANY) {
          console.log(`[superScraper] Phase 4: cost budget exceeded (~$${estimatedCost.toFixed(4)}) — stopping`);
          break;
        }

        const plan = await planNextAction(
          companyName, url, objective, sections, data,
          visitedUrls, availableLinks, hopsUsed, MAX_AGENT_HOPS, webSearchedFields,
        );
        phase4LlmCalls++;

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

          // LLM extraction on this page (nano — just structured extraction)
          if (!isCancelled?.()) {
            try {
              data = await llmExtractFields([fetched], sections, systemPrompt, data, MODEL_NANO);
              phase4LlmCalls++;
            } catch { /* non-fatal */ }
          }

        } else if (plan.action === "web_search") {
          // Query diversification — generate 2 additional queries for different angles
          const still_missing = sections.filter(s => !data[s.key]?.trim());
          const diverseQueries = [plan.query];
          if (still_missing.some(s => /email|contact/i.test(s.key + " " + s.label))) {
            diverseQueries.push(`"${companyName}" founder OR CEO OR partner email`);
          }
          if (still_missing.some(s => /linkedin/i.test(s.key + " " + s.label))) {
            diverseQueries.push(`site:linkedin.com/in "${companyName}" partner OR founder`);
          }
          // Analytical fields — search for business context, tech stack, services
          if (still_missing.some(s => /fit|need|signal|competitor|service|qualification/i.test(s.key + " " + s.label))) {
            diverseQueries.push(`"${companyName}" site:builtwith.com OR site:crunchbase.com OR "technology" OR "services"`);
          }
          // Deduplicate queries
          const uniqueQueries = [...new Set(diverseQueries)].slice(0, 3);

          let searchResults: Array<{ url: string; title: string; snippet: string }> = [];
          for (const q of uniqueQueries) {
            const results = await searchWeb(q, 3);
            searchResults.push(...results);
          }
          // Deduplicate search results by URL
          const seenSearchUrls = new Set<string>();
          searchResults = searchResults.filter(r => {
            if (seenSearchUrls.has(r.url) || visitedUrls.has(r.url)) return false;
            seenSearchUrls.add(r.url);
            return true;
          });

          if (searchResults.length === 0) { hopsUsed++; continue; }
          hopsUsed++;

          // Snippet-first evaluation — check if snippets already contain the answer
          const snippetContent = searchResults.map(r => `${r.title}\n${r.snippet}`).join("\n\n");
          const snippetPage: FetchedPage = { url: "search-snippets", content: snippetContent, links: [] };
          const preSnippetData = { ...data };
          try {
            data = await llmExtractFields([snippetPage], sections, systemPrompt, data, MODEL_NANO);
            phase4LlmCalls++;
          } catch { /* non-fatal */ }

          // If snippets filled new fields, we might be done
          const snippetFilledNew = sections.some(s => data[s.key]?.trim() && !preSnippetData[s.key]?.trim());
          if (snippetFilledNew) {
            console.log(`[superScraper] Phase 4: extracted data from search snippets (saved full page fetches)`);
          }

          // If still missing critical fields, fetch the top search results
          if (!criticalFieldsFilled(sections, fieldResults)) {
            const candidates = searchResults.slice(0, 2);
            for (const result of candidates) {
              if (isCancelled?.()) throw new Error("JOB_CANCELLED");
              const fetched = await fetchPage(result.url, isCancelled);
              if (fetched) {
                visitedUrls.add(result.url);
                allPages.push(fetched);
                if (!isCancelled?.()) {
                  try {
                    data = await llmExtractFields([fetched], sections, systemPrompt, data, MODEL_NANO);
                    phase4LlmCalls++;
                  } catch { /* non-fatal */ }
                }
              } else {
                visitedUrls.add(result.url);
              }
              if (sections.every(s => data[s.key]?.trim())) break;
            }
          }

          // Track searched field to avoid re-searching
          const weakest = sections.filter(s => !data[s.key]?.trim())[0];
          if (weakest) webSearchedFields.add(weakest.key);
        }

        // Update fieldResults from data for gate checks
        for (const s of sections) {
          if (data[s.key]?.trim() && !(fieldResults[s.key]?.value?.trim())) {
            fieldResults[s.key] = { value: data[s.key], confidence: CONFIDENCE.INFERRED, sourceUrl: "phase4" };
          }
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
      diag.phase4FieldsFilled = phase4Filled;
      console.log(`[superScraper] Phase 4 complete: ${phase4Filled}/${sections.length} fields filled (${phase4LlmCalls} LLM calls)`);
    } // end gate 2
  } // end gate 1

  // ── PHASE 5: VALIDATION + FINAL LLM CONSOLIDATION ────────────────────────

  // 5a. LLM-as-Judge validation — catch bad data before final consolidation
  if (!isCancelled?.()) {
    console.log(`[superScraper] Phase 5a: Validating extracted data`);
    try {
      const validation = await validateExtraction(data, sections, companyName, url);
      if (!validation.valid && Object.keys(validation.corrections).length > 0) {
        console.log(`[superScraper] Validation flagged ${Object.keys(validation.corrections).length} field(s)`);
        for (const [key, correction] of Object.entries(validation.corrections)) {
          if (correction === "REMOVE" || correction === "remove") {
            data[key] = "";
            delete fieldResults[key];
          } else if (correction.trim()) {
            data[key] = correction;
            if (fieldResults[key]) fieldResults[key].value = correction;
          }
        }
      }
    } catch (err) {
      console.warn(`[superScraper] Phase 5a validation failed (non-fatal):`, err);
      extractionFailures.push(`Phase 5a validation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 5b. Final consolidation pass — fill any remaining gaps
  if (!isCancelled?.() && sections.some(s => !data[s.key]?.trim())) {
    console.log(`[superScraper] Phase 5b: Final LLM consolidation`);
    try {
      data = await llmExtractFields(allPages, sections, systemPrompt, data, MODEL_NANO);
    } catch (err) {
      console.warn(`[superScraper] Phase 5b failed (non-fatal):`, err);
      extractionFailures.push(`Phase 5b consolidation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  diag.phase5FieldsFilled = sections.filter(s => data[s.key]?.trim()).length;

  // ── PHASE 6: POST-SCRAPE ENRICHMENT CASCADE ──��─────────────────────────────
  //
  //  Step 1: Hunter + Apollo run in PARALLEL (different data, complementary):
  //    1a. Hunter Domain Search — verified emails + names (~$0.01/call)
  //    1b. Apollo People Search — people by title/seniority at domain (free)
  //  Step 2: SMTP handshake — generic email fallback (free, last resort)
  //
  //  Each step is independently gated and non-fatal.

  const _domain = (() => {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch { return url; }
  })();

  // ── Step 1: Hunter + Apollo in parallel ────────────────────────────────────
  if (!isCancelled?.()) {
    const hunterPromise = (async () => {
      try {
        const { hunterDomainSearch } = await import("./dataSources/hunterApi");
        const { addExternalCost } = await import("./_core/openaiLLM");
        const hunterResult = await hunterDomainSearch(_domain, sections, fieldResults);
        if (!hunterResult.skippedReason) {
          addExternalCost(0.01, "hunter.io domain search");
        }
        return hunterResult;
      } catch (err) {
        console.warn(`[superScraper] Hunter Domain Search failed (non-fatal):`, err);
        extractionFailures.push(`Hunter API: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    })();

    const apolloPromise = (async () => {
      try {
        const { apolloPeopleSearch, shouldRunApolloSearch } = await import("./dataSources/apolloApi");
        if (!shouldRunApolloSearch().run) return null;
        return await apolloPeopleSearch(_domain);
      } catch (err) {
        console.warn(`[superScraper] Apollo People Search failed (non-fatal):`, err);
        extractionFailures.push(`Apollo API: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    })();

    const [hunterSettled, apolloSettled] = await Promise.allSettled([hunterPromise, apolloPromise]);

    // Merge Hunter results (emails, names, titles, LinkedIn)
    const hunterResult = hunterSettled.status === "fulfilled" ? hunterSettled.value : null;
    if (hunterResult?.bestMatch) {
      const hm = hunterResult.bestMatch;
      const sourceUrl = `https://hunter.io/domain-search?domain=${_domain}`;

      for (const s of sections) {
        const kl = s.key.toLowerCase();
        const isDm = /decision.?maker|dm\d|contact|person/.test(kl);

        if (isDm && /name/.test(kl) && !fieldResults[s.key]?.value && hm.firstName) {
          const fullName = `${hm.firstName} ${hm.lastName}`.trim();
          fieldResults[s.key] = { value: fullName, confidence: CONFIDENCE.EXTRACTED, sourceUrl };
          data[s.key] = fullName;
        } else if (isDm && /title|role|position/.test(kl) && !fieldResults[s.key]?.value && hm.position) {
          fieldResults[s.key] = { value: hm.position, confidence: CONFIDENCE.EXTRACTED, sourceUrl };
          data[s.key] = hm.position;
        } else if (/email/i.test(kl) && !fieldResults[s.key]?.value && hm.value) {
          fieldResults[s.key] = {
            value: hm.value,
            confidence: Math.min(0.95, hm.confidence / 100),
            sourceUrl,
          };
          data[s.key] = hm.value;
        } else if (isDm && /linkedin/.test(kl) && !fieldResults[s.key]?.value && hm.linkedinUrl) {
          fieldResults[s.key] = { value: hm.linkedinUrl, confidence: CONFIDENCE.VERIFIED, sourceUrl: hm.linkedinUrl };
          data[s.key] = hm.linkedinUrl;
        }
      }
      console.log(
        `[superScraper] Hunter merged: ${hm.firstName} ${hm.lastName} <${hm.value}> (${hm.position || hm.seniority || "?"})`,
      );
    } else if (hunterResult?.skippedReason) {
      console.log(`[superScraper] Hunter skipped: ${hunterResult.skippedReason}`);
    }

    // Merge Apollo results (people discovery — names, titles, LinkedIn, location)
    const apolloResult = apolloSettled.status === "fulfilled" ? apolloSettled.value : null;
    if (apolloResult && apolloResult.people.length > 0) {
      console.log(`[superScraper] Apollo found ${apolloResult.people.length} people at ${_domain}`);

      const hunterEmails = hunterResult?.allEmails ?? [];

      // Resolve obfuscated Apollo names via SERP (if Serper key available)
      let serperAvailable = false;
      let resolveLinkedInFn: typeof import("./dataSources/serperSearch").resolveLinkedInViaSERP | null = null;
      try {
        const serperModule = await import("./dataSources/serperSearch");
        serperAvailable = serperModule.isSerperAvailable();
        resolveLinkedInFn = serperModule.resolveLinkedInViaSERP;
      } catch { /* serper not available */ }

      for (const person of apolloResult.people) {
        let resolvedName = person.name;
        let resolvedLinkedin: string | null = null;

        // If Apollo returned an obfuscated last name (contains *), resolve via SERP
        const hasObfuscatedLast = person.lastName.includes("*") || person.lastName.length <= 2;
        if (hasObfuscatedLast && serperAvailable && resolveLinkedInFn && person.firstName) {
          try {
            const serpResult = await resolveLinkedInFn(
              person.firstName,
              person.title,
              person.organizationName || _domain,
              _domain,
            );
            if (serpResult.fullName) {
              resolvedName = serpResult.fullName;
              console.log(`[superScraper] SERP resolved: ${person.firstName} ${person.lastName} → ${resolvedName}`);
            }
            if (serpResult.linkedinUrl) {
              resolvedLinkedin = serpResult.linkedinUrl;
            }
            // Small delay between SERP calls
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (err) {
            console.warn(`[superScraper] SERP resolve failed for ${person.firstName} (non-fatal):`, err);
          }
        }

        // Cross-reference with Hunter emails by name
        const matchingHunterEmail = hunterEmails.find(he => {
          const hunterName = `${he.firstName} ${he.lastName}`.trim().toLowerCase();
          const nameToMatch = resolvedName.toLowerCase();
          return hunterName === nameToMatch ||
            (he.firstName && nameToMatch.includes(he.firstName.toLowerCase()) &&
             he.lastName && nameToMatch.includes(he.lastName.toLowerCase()));
        });

        // Merge into DM fields if still empty
        for (const s of sections) {
          const kl = s.key.toLowerCase();
          const isDm = /decision.?maker|dm\d|contact|person/.test(kl);

          if (isDm && /name/.test(kl) && !fieldResults[s.key]?.value && resolvedName) {
            fieldResults[s.key] = { value: resolvedName, confidence: CONFIDENCE.EXTRACTED, sourceUrl: "apollo.io" };
            data[s.key] = resolvedName;
          } else if (isDm && /title|role|position/.test(kl) && !fieldResults[s.key]?.value && person.title) {
            fieldResults[s.key] = { value: person.title, confidence: CONFIDENCE.EXTRACTED, sourceUrl: "apollo.io" };
            data[s.key] = person.title;
          } else if (/email/i.test(kl) && !fieldResults[s.key]?.value && matchingHunterEmail?.value) {
            fieldResults[s.key] = {
              value: matchingHunterEmail.value,
              confidence: Math.min(CONFIDENCE.VERIFIED, matchingHunterEmail.confidence / 100),
              sourceUrl: "hunter.io + apollo.io",
            };
            data[s.key] = matchingHunterEmail.value;
          } else if (isDm && /linkedin/.test(kl) && !fieldResults[s.key]?.value && resolvedLinkedin) {
            fieldResults[s.key] = { value: resolvedLinkedin, confidence: CONFIDENCE.EXTRACTED, sourceUrl: "serper + apollo.io" };
            data[s.key] = resolvedLinkedin;
          }
        }
      }
    } else if (apolloResult?.skippedReason) {
      console.log(`[superScraper] Apollo skipped: ${apolloResult.skippedReason}`);
    }
  }

  // ── Step 2: SMTP Generic Email — fallback OR upgrade from sales-only email ──
  if (!isCancelled?.()) {
    try {
      const { shouldRunSmtpFallback, smtpVerifyGenericEmail } = await import("./dataSources/smtpVerify");

      // Check if the only email we have is a sales/hr/recruitment-type email
      // that's a poor match for operations/decision-maker outreach
      const SALES_PREFIXES = /^(sales|hr|recruitment|recruiting|careers|jobs|marketing|pr|press|media|events|partnerships)@/i;
      let hasSalesOnlyEmail = false;
      for (const s of sections) {
        if (/email/i.test(s.key + " " + s.label) && fieldResults[s.key]?.value) {
          const currentEmail = fieldResults[s.key]!.value.trim().toLowerCase();
          if (SALES_PREFIXES.test(currentEmail)) {
            hasSalesOnlyEmail = true;
          }
        }
      }

      const shouldRun = shouldRunSmtpFallback(sections, fieldResults) || hasSalesOnlyEmail;

      if (shouldRun) {
        const smtpResult = await smtpVerifyGenericEmail(_domain);
        if (smtpResult) {
          const sourceUrl = `smtp://${smtpResult.mxHost}:${smtpResult.port}`;
          for (const s of sections) {
            if (/email/i.test(s.key + " " + s.label)) {
              const currentEmail = fieldResults[s.key]?.value?.trim().toLowerCase() || "";

              if (!currentEmail) {
                // No email at all — use SMTP result
                fieldResults[s.key] = {
                  value: smtpResult.email,
                  confidence: smtpResult.catchAll ? CONFIDENCE.INFERRED : CONFIDENCE.EXTRACTED,
                  sourceUrl,
                };
                data[s.key] = smtpResult.email;
              } else if (SALES_PREFIXES.test(currentEmail) && smtpResult.email !== currentEmail) {
                // Has a sales-type email — prepend the verified generic as primary,
                // keep the sales email as secondary
                const combined = `${smtpResult.email}; ${currentEmail}`;
                fieldResults[s.key] = {
                  value: combined,
                  confidence: smtpResult.catchAll ? CONFIDENCE.INFERRED : CONFIDENCE.EXTRACTED,
                  sourceUrl,
                };
                data[s.key] = combined;
                console.log(`[superScraper] SMTP upgrade: ${currentEmail} → ${smtpResult.email} (primary); ${currentEmail} (secondary)`);
              }
            }
          }
          console.log(`[superScraper] SMTP verified: ${smtpResult.email} (catch-all: ${smtpResult.catchAll})`);
        }
      }
    } catch (err) {
      console.warn(`[superScraper] SMTP fallback failed (non-fatal):`, err);
    }
  }

  // ── Step 3: SMTP name-based email probe (last resort) ──────────────────────
  //  If we have a person's name but no personal email, try SMTP with their
  //  name patterns (john.smith@, jsmith@, etc.) against the domain's mail server.
  if (!isCancelled?.()) {
    try {
      // Find a DM name field that has a value, and an email field that's empty or generic-only
      let dmName: string | null = null;
      let emailSectionKey: string | null = null;

      for (const s of sections) {
        const combined = (s.key + " " + s.label).toLowerCase();
        if (/decision.?maker|key.?contact|erp.?contact|primary.?contact|dm\d|contact.?name/i.test(combined) && data[s.key]?.trim()) {
          // Extract just the name part (strip title/role after comma)
          const raw = data[s.key].trim();
          const nameOnly = raw.split(/[,;|–—]/).map((p: string) => p.trim()).find((p: string) => {
            // Must look like a name (2+ words, no @ or digits-only)
            return p.split(/\s+/).length >= 2 && !p.includes("@") && !/^\d+$/.test(p) && !p.toLowerCase().startsWith("no ");
          });
          if (nameOnly) dmName = nameOnly;
        }
        if (/email|contact.?email/i.test(combined)) {
          emailSectionKey = s.key;
        }
      }

      if (dmName && emailSectionKey) {
        const currentEmail = (fieldResults[emailSectionKey]?.value || "").trim().toLowerCase();
        const hasPersonalEmail = currentEmail && !currentEmail.startsWith("info@") && !currentEmail.startsWith("contact@")
          && !currentEmail.startsWith("hello@") && !currentEmail.startsWith("office@") && !currentEmail.startsWith("admin@")
          && !currentEmail.startsWith("team@") && !currentEmail.startsWith("general@") && !currentEmail.startsWith("sales@")
          && !currentEmail.startsWith("hr@") && currentEmail.includes("@");

        if (!hasPersonalEmail) {
          const nameParts = dmName.split(/\s+/).filter((p: string) => p.length > 0);
          if (nameParts.length >= 2) {
            const firstName = nameParts[0];
            const lastName = nameParts[nameParts.length - 1];
            const { smtpVerifyPersonEmail } = await import("./dataSources/smtpVerify");
            const personResult = await smtpVerifyPersonEmail(firstName, lastName, _domain);

            if (personResult) {
              const existing = data[emailSectionKey] || "";
              const combined = existing ? `${personResult.email}; ${existing}` : personResult.email;
              fieldResults[emailSectionKey] = {
                value: combined,
                confidence: personResult.catchAll ? CONFIDENCE.INFERRED : CONFIDENCE.EXTRACTED,
                sourceUrl: `smtp://${personResult.mxHost}:${personResult.port}`,
              };
              data[emailSectionKey] = combined;
              console.log(`[superScraper] SMTP name probe: ${dmName} → ${personResult.email} (catch-all: ${personResult.catchAll})`);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[superScraper] SMTP name probe failed (non-fatal):`, err);
      extractionFailures.push(`SMTP name probe: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── BUILD FINAL RESULT ─────────────────────────────────────────────────────

  const emptyFields = sections.map(s => s.key).filter(k => !data[k] || data[k].trim() === "");

  // ── Count REAL emails (not noise) across extracted data + page content ────
  // Only count personal emails (not generic info@, support@, etc.)
  const emailRegexFinal = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
  const noiseEmailPrefix = /^(info|contact|hello|support|admin|team|press|media|careers|jobs|hr|sales|marketing|legal|privacy|security|noreply|no-reply|webmaster|postmaster|news|newsletter|office|help|mail|billing|feedback|enquiries|general|reception)@/i;
  const noiseEmailDomain = /\.(png|jpg|gif|svg|css|js|woff|ico)$/i; // image references like user@2x.png

  // First: count emails actually extracted into data fields
  const fieldEmails = new Set<string>();
  for (const [, val] of Object.entries(data)) {
    if (!val) continue;
    const matches = val.match(emailRegexFinal) ?? [];
    for (const m of matches) {
      const lower = m.toLowerCase();
      if (!noiseEmailPrefix.test(lower) && !noiseEmailDomain.test(lower)) {
        fieldEmails.add(lower);
      }
    }
  }

  // Second: count personal emails found on team/contact pages (not all pages)
  const contactPages = allPages.filter(p =>
    /\/(team|people|staff|leadership|about|contact|founders|partners)/i.test(p.url)
  );
  const pageEmails = new Set<string>();
  for (const page of contactPages) {
    const matches = page.content.match(emailRegexFinal) ?? [];
    for (const m of matches) {
      const lower = m.toLowerCase();
      if (!noiseEmailPrefix.test(lower) && !noiseEmailDomain.test(lower)) {
        pageEmails.add(lower);
      }
    }
  }
  // Merge — field emails take priority, page emails supplement
  const uniqueEmailsFinal = new Set([...fieldEmails, ...pageEmails]);

  // ── Count people actually extracted into data fields ──────────────────────
  // Don't regex-guess names from page content (too many false positives like
  // "Real Estate", "San Francisco", "Our Services"). Instead, count people
  // that the LLM or deterministic extractor actually placed into fields.
  const peopleFieldPatterns = /decision.?maker|key.?contact|contact.?info|team|people|person|name|founder|ceo|partner|staff|agent/i;
  let extractedPersonCount = 0;
  for (const s of sections) {
    const combined = s.key + " " + s.label;
    if (peopleFieldPatterns.test(combined) && data[s.key]?.trim()) {
      // Count semicolons/commas as separators for multi-person fields
      const val = data[s.key];
      // Check if the value contains actual name-like content (not just titles or descriptions)
      const nameishPattern = /[A-Z][a-z]+\s[A-Z][a-z]+/g;
      const names = val.match(nameishPattern) ?? [];
      extractedPersonCount += Math.max(names.length, val.trim() ? 1 : 0);
    }
  }
  // Also count LinkedIn profile URLs as people (each profile = one person)
  for (const s of sections) {
    if (/linkedin/i.test(s.key + " " + s.label) && data[s.key]?.trim()) {
      const profileUrls = data[s.key].match(/linkedin\.com\/in\//gi) ?? [];
      if (profileUrls.length > 0 && extractedPersonCount === 0) {
        extractedPersonCount = profileUrls.length;
      }
    }
  }

  const stats: ScrapeStats = {
    fieldsTotal: sections.length,
    fieldsFilled: sections.length - emptyFields.length,
    emptyFields,
    emailCount: uniqueEmailsFinal.size,
    personCount: extractedPersonCount,
    hasData: sections.length - emptyFields.length > 0,
  };

  const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);

  // Log failure summary (never silent — always visible)
  if (extractionFailures.length > 0) {
    console.warn(`[superScraper] ⚠️ ${extractionFailures.length} non-fatal failures for ${url}:`);
    extractionFailures.forEach(f => console.warn(`  - ${f}`));
  }

  console.log(
    `[superScraper] ✅ Done: ${allPages.length} pages, ` +
    `${stats.fieldsFilled}/${sections.length} filled, ` +
    `${stats.emailCount} emails, ${stats.personCount} people, ` +
    `${extractionFailures.length} failures, ${durationSec}s`,
  );

  return { type: "profile", data, stats, diagnostics: { ...diag, failures: extractionFailures } };
}
