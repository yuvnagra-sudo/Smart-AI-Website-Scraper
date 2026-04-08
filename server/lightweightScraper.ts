/**
 * Lightweight Scraper Engine
 * ==========================
 *
 * A near-zero-cost replacement for the multi-hop LLM agent loop.
 *
 * Architecture (inspired by scraper-app reference implementation):
 *
 *   Phase 1 — URL Discovery
 *     1a. Fetch homepage via Jina (JS-rendered, no Puppeteer cost)
 *     1b. Parse sitemap.xml for additional paths
 *     1c. Heuristic link discovery from homepage HTML
 *     1d. Inject standard candidate paths (/team, /about, /contact, etc.)
 *
 *   Phase 2 — Parallel Page Fetch
 *     Fetch all discovered URLs concurrently (bounded by semaphore).
 *     Each page is fetched once via Jina — no re-visits, no planning loop.
 *
 *   Phase 3 — Deterministic Extraction (zero LLM cost)
 *     3a. JSON-LD / Schema.org structured data (confidence 0.99)
 *     3b. CSS card heuristics for team members (confidence 0.88)
 *     3c. Regex: emails, phones, LinkedIn URLs (confidence 0.92)
 *     3d. Name+title pattern matching from visible text (confidence 0.75)
 *     3e. mailto: link extraction (confidence 0.90)
 *
 *   Phase 4 — Enrichment Cascade (same as current, unchanged)
 *     4a. Direct email scraper — already ran in Phase 3, skip if found
 *     4b. Hunter Domain Search — $0.01/call, skipped if personal email found
 *     4c. Apify LinkedIn — $0.008/profile, skipped if Hunter had DM name
 *     4d. SMTP handshake — free, last resort
 *
 *   Phase 5 — Optional Single LLM Pass (gated, ~$0.002/firm)
 *     Only fires when critical fields (DM name, email) are STILL empty after
 *     all deterministic + enrichment steps. Uses gpt-4.1-nano with a compact
 *     prompt to fill remaining gaps. Maximum 1 LLM call per firm.
 *
 * Cost comparison:
 *   Old agent loop:  ~$0.018–0.022/firm (7 LLM calls: 1 planner + 6 extractors)
 *   New lightweight: ~$0.000–0.003/firm (0–1 LLM calls, only when needed)
 *
 * The scrapeUrlLightweight() function is a drop-in replacement for scrapeUrl()
 * in routers.ts — same signature, same return type (AgentScrapeResult).
 */

import { fetchViaJina } from "./jinaFetcher";
import { queuedLLMCall } from "./_core/llmQueue";
import { preLLMExtract, preLLMExtractFull, CONFIDENCE } from "./preLLMExtractor";
import { hunterDomainSearch } from "./dataSources/hunterApi";
import { smtpVerifyGenericEmail, shouldRunSmtpFallback } from "./dataSources/smtpVerify";
import { scrapeEmailsFromDomain } from "./dataSources/directEmailScraper";
import { enrichWithLinkedIn } from "./dataSources/apifyLinkedin";
import { discoverRelevantURLs, generateStandardURLs } from "./multiUrlDiscovery";
import { getProfile } from "./agentConfig";
import type { AgentSection, AgentScrapeResult, FieldResultMap, FieldResult, ScrapeStats } from "./agentScraper";
import type { SkillContext } from "../shared/skillContext";
import * as cheerio from "cheerio";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum pages to fetch per firm (homepage + discovered pages). */
const MAX_PAGES = parseInt(process.env.LW_MAX_PAGES ?? "12", 10);

/** Concurrency limit for parallel page fetches within a single firm. */
const FETCH_CONCURRENCY = parseInt(process.env.LW_FETCH_CONCURRENCY ?? "6", 10);

/** Confidence threshold below which the optional LLM pass fires. */
const LLM_GATE_THRESHOLD = 0.65;

/** Standard candidate paths to always check (union of scraper-app + current paths). */
const STANDARD_PATHS = [
  "/",
  "/about",
  "/about-us",
  "/team",
  "/our-team",
  "/people",
  "/leadership",
  "/management",
  "/staff",
  "/contact",
  "/contact-us",
  "/who-we-are",
  "/company",
  "/portfolio",
  "/work",
  "/services",
];

// ---------------------------------------------------------------------------
// Sitemap Parser
// ---------------------------------------------------------------------------

/**
 * Fetch and parse sitemap.xml (and sitemap_index.xml) to discover URLs.
 * Returns up to `limit` URLs that look like content pages (not assets/feeds).
 */
async function fetchSitemapUrls(baseUrl: string, limit = 50): Promise<string[]> {
  const domain = (() => {
    try { return new URL(baseUrl).origin; } catch { return baseUrl; }
  })();

  const sitemapCandidates = [
    `${domain}/sitemap.xml`,
    `${domain}/sitemap_index.xml`,
    `${domain}/sitemap-index.xml`,
    `${domain}/sitemaps.xml`,
  ];

  const urls: string[] = [];
  const seen = new Set<string>();

  for (const sitemapUrl of sitemapCandidates) {
    try {
      const result = await fetchViaJina(sitemapUrl);
      if (!result?.success || !result.content) continue;

      const content = result.content;

      // Parse <loc> tags from sitemap XML (Jina returns as text/markdown)
      const locMatches = content.match(/<loc>([^<]+)<\/loc>/gi) ?? [];
      for (const match of locMatches) {
        const url = match.replace(/<\/?loc>/gi, "").trim();
        if (!url.startsWith("http")) continue;
        if (seen.has(url)) continue;
        // Skip asset URLs
        if (/\.(jpg|jpeg|png|gif|svg|pdf|zip|css|js|xml|rss|atom)$/i.test(url)) continue;
        // Prefer pages that look like contact/team/about pages
        seen.add(url);
        urls.push(url);
        if (urls.length >= limit) break;
      }

      if (urls.length > 0) break; // Found a working sitemap
    } catch {
      // Sitemap not found or parse error — non-fatal
    }
  }

  console.log(`[lightweightScraper] Sitemap: found ${urls.length} URLs`);
  return urls;
}

// ---------------------------------------------------------------------------
// URL Prioritisation
// ---------------------------------------------------------------------------

/**
 * Score a URL for relevance to B2B contact extraction.
 * Higher score = fetch first.
 */
function scoreUrl(url: string): number {
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return url.toLowerCase(); } })();

  // Highest priority: contact/team/about pages
  if (/\/(contact|contact-us|contactus|get-in-touch|reach-us)/.test(path)) return 100;
  if (/\/(team|our-team|leadership|management|people|staff|founders)/.test(path)) return 95;
  if (/\/(about|about-us|aboutus|who-we-are|company)/.test(path)) return 80;
  if (/\/(portfolio|work|clients|case-studies)/.test(path)) return 60;
  if (/\/(services|solutions|what-we-do)/.test(path)) return 50;
  if (path === "/" || path === "") return 90; // Homepage always high priority
  return 30;
}

/**
 * Deduplicate and prioritise a list of URLs, keeping the top N.
 */
function prioritiseUrls(urls: string[], baseUrl: string, maxUrls: number): string[] {
  const baseDomain = (() => { try { return new URL(baseUrl).hostname; } catch { return ""; } })();
  const seen = new Set<string>();
  const filtered: string[] = [];

  for (const url of urls) {
    try {
      const parsed = new URL(url);
      // Only same-domain URLs
      if (parsed.hostname !== baseDomain && !parsed.hostname.endsWith(`.${baseDomain}`)) continue;
      // Skip asset URLs
      if (/\.(jpg|jpeg|png|gif|svg|pdf|zip|css|js|woff|ttf|ico)$/i.test(parsed.pathname)) continue;
      // Skip fragment-only or query-heavy URLs
      if (parsed.hash && !parsed.pathname) continue;
      const normalised = `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "") || parsed.origin;
      if (seen.has(normalised)) continue;
      seen.add(normalised);
      filtered.push(normalised);
    } catch {
      // Invalid URL
    }
  }

  return filtered
    .sort((a, b) => scoreUrl(b) - scoreUrl(a))
    .slice(0, maxUrls);
}

// ---------------------------------------------------------------------------
// Deterministic Field Extraction
// ---------------------------------------------------------------------------

/**
 * Merge a new FieldResultMap into an existing one.
 * Only overwrites a field if the new confidence is higher.
 */
function mergeFieldResults(existing: FieldResultMap, incoming: FieldResultMap): FieldResultMap {
  const merged = { ...existing };
  for (const [key, result] of Object.entries(incoming)) {
    const current = merged[key];
    if (!current || (result.confidence > (current.confidence ?? 0))) {
      merged[key] = result;
    }
  }
  return merged;
}

/**
 * Extract emails from raw HTML/text using regex.
 * Returns a map of email → { type, sourceUrl }.
 */
function extractEmailsFromContent(
  content: string,
  sourceUrl: string,
): Array<{ email: string; type: "personal" | "generic"; sourceUrl: string }> {
  const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const NOISE_PREFIXES = new Set([
    "noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon",
    "postmaster", "abuse", "webmaster", "example", "test", "user", "email",
    "your", "name", "username", "sentry", "wix", "wordpress", "jquery",
    "bootstrap", "cloudflare", "google", "facebook", "twitter", "github",
  ]);
  const NOISE_DOMAINS = new Set([
    "example.com", "sentry.io", "wixpress.com", "wordpress.org", "jquery.com",
    "w3.org", "schema.org", "googleapis.com", "google.com", "facebook.com",
    "twitter.com", "github.com", "cloudflare.com", "gravatar.com",
  ]);
  const GENERIC_PREFIXES = new Set([
    "info", "contact", "hello", "admin", "office", "general", "support",
    "sales", "service", "customerservice", "help", "enquiries", "inquiries",
    "mail", "team", "feedback",
  ]);

  const found: Array<{ email: string; type: "personal" | "generic"; sourceUrl: string }> = [];
  const seen = new Set<string>();

  const matches = content.match(EMAIL_REGEX) ?? [];
  for (const raw of matches) {
    const lower = raw.toLowerCase().replace(/\.$/, "");
    if (seen.has(lower)) continue;
    const atIdx = lower.indexOf("@");
    if (atIdx === -1) continue;
    const prefix = lower.slice(0, atIdx);
    const domain = lower.slice(atIdx + 1);
    if (!domain.includes(".")) continue;
    if (NOISE_DOMAINS.has(domain)) continue;
    if (NOISE_PREFIXES.has(prefix)) continue;
    if (prefix.length > 40 || domain.length > 60) continue;
    if (/^\d+$/.test(prefix)) continue;
    seen.add(lower);
    found.push({
      email: lower,
      type: GENERIC_PREFIXES.has(prefix) ? "generic" : "personal",
      sourceUrl,
    });
  }

  return found;
}

/**
 * Extract LinkedIn URLs from content.
 */
function extractLinkedInUrls(content: string): { personal: string[]; company: string[] } {
  const personal: string[] = [];
  const company: string[] = [];
  const seenPersonal = new Set<string>();
  const seenCompany = new Set<string>();

  const personalMatches = content.matchAll(/linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)/gi);
  for (const m of personalMatches) {
    const slug = m[1].toLowerCase();
    if (["login", "signup", "share", "pulse", "feed"].includes(slug)) continue;
    const url = `https://linkedin.com/in/${slug}`;
    if (!seenPersonal.has(url)) { seenPersonal.add(url); personal.push(url); }
  }

  const companyMatches = content.matchAll(/linkedin\.com\/company\/([a-zA-Z0-9\-_%]+)/gi);
  for (const m of companyMatches) {
    const slug = m[1].toLowerCase();
    const url = `https://linkedin.com/company/${slug}`;
    if (!seenCompany.has(url)) { seenCompany.add(url); company.push(url); }
  }

  return { personal, company };
}

/**
 * Extract phone numbers from content.
 */
function extractPhones(content: string): string[] {
  const phones: string[] = [];
  const seen = new Set<string>();
  // Match common phone formats: +1 (555) 555-5555, 555-555-5555, etc.
  const matches = content.matchAll(/(?:\+\d{1,3}[\s\-]?)?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{4}/g);
  for (const m of matches) {
    const cleaned = m[0].replace(/\s+/g, " ").trim();
    if (!seen.has(cleaned)) { seen.add(cleaned); phones.push(cleaned); }
  }
  return phones.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Name + Title Pattern Extraction
// ---------------------------------------------------------------------------

const NAME_TITLE_PATTERNS = [
  // "John Smith, CEO" or "John Smith - CEO"
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*[,\-–|]\s*((?:CEO|CTO|CFO|COO|CMO|CPO|CIO|CISO|VP|SVP|EVP|Director|Head|Manager|Founder|Co-Founder|Partner|President|Principal|Associate|Analyst)[^,\n]{0,50})/g,
  // "CEO: John Smith" or "Founder | John Smith"
  /(CEO|CTO|CFO|COO|CMO|CPO|CIO|CISO|VP|SVP|EVP|Director|Head of [A-Za-z]+|Manager|Founder|Co-Founder|Partner|President|Principal)\s*[:\-–|]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/g,
];

interface PersonCandidate {
  name: string;
  title: string;
  confidence: number;
  sourceUrl: string;
}

function extractPeopleFromText(text: string, sourceUrl: string): PersonCandidate[] {
  const people: PersonCandidate[] = [];
  const seenNames = new Set<string>();

  // Pattern 1: Name, Title
  const p1Matches = text.matchAll(NAME_TITLE_PATTERNS[0]);
  for (const m of p1Matches) {
    const name = m[1].trim();
    const title = m[2].trim();
    if (seenNames.has(name.toLowerCase())) continue;
    if (name.split(" ").length < 2) continue; // Skip single-word "names"
    seenNames.add(name.toLowerCase());
    people.push({ name, title, confidence: 0.75, sourceUrl });
  }

  // Pattern 2: Title: Name
  const p2Matches = text.matchAll(NAME_TITLE_PATTERNS[1]);
  for (const m of p2Matches) {
    const title = m[1].trim();
    const name = m[2].trim();
    if (seenNames.has(name.toLowerCase())) continue;
    if (name.split(" ").length < 2) continue;
    seenNames.add(name.toLowerCase());
    people.push({ name, title, confidence: 0.75, sourceUrl });
  }

  return people;
}

// ---------------------------------------------------------------------------
// Section Field Mapping
// ---------------------------------------------------------------------------

/**
 * Map extracted raw data to the structured field results expected by the
 * existing routers.ts / Excel export pipeline.
 *
 * This is the bridge between the lightweight scraper's flat extraction
 * results and the FieldResultMap format used by the rest of the system.
 */
function mapToFieldResults(
  sections: AgentSection[],
  emails: Array<{ email: string; type: "personal" | "generic"; sourceUrl: string }>,
  people: PersonCandidate[],
  linkedInPersonal: string[],
  linkedInCompany: string[],
  phones: string[],
  jsonLdData: Record<string, string>,
  existingResults: FieldResultMap,
): FieldResultMap {
  const results: FieldResultMap = { ...existingResults };

  // Sort emails: personal first, then by source priority
  const sortedEmails = [...emails].sort((a, b) => {
    if (a.type === "personal" && b.type !== "personal") return -1;
    if (a.type !== "personal" && b.type === "personal") return 1;
    return 0;
  });

  // Sort people by title seniority
  const TITLE_PRIORITY = ["ceo", "cto", "cfo", "coo", "founder", "co-founder", "president", "director", "vp", "head", "manager", "partner"];
  const sortedPeople = [...people].sort((a, b) => {
    const aScore = TITLE_PRIORITY.findIndex(t => a.title.toLowerCase().includes(t));
    const bScore = TITLE_PRIORITY.findIndex(t => b.title.toLowerCase().includes(t));
    return (aScore === -1 ? 99 : aScore) - (bScore === -1 ? 99 : bScore);
  });

  for (const section of sections) {
    const key = section.key.toLowerCase();
    const existing = results[section.key];

    // Skip if already high-confidence
    if (existing && existing.confidence >= 0.85) continue;

    // ── Email fields ──────────────────────────────────────────────────────
    if (/email/i.test(section.key + " " + section.label)) {
      const best = sortedEmails[0];
      if (best && (!existing || best.type === "personal")) {
        results[section.key] = {
          value: best.email,
          confidence: best.type === "personal" ? 0.82 : 0.65,
          sourceUrl: best.sourceUrl,
          extractionMethod: "regex",
        };
      }
    }

    // ── Name fields ───────────────────────────────────────────────────────
    else if (/\bname\b/i.test(section.key + " " + section.label) &&
             /decision.?maker|dm\d|contact|person/i.test(section.key)) {
      // Try JSON-LD first
      if (jsonLdData.personName && !existing?.value) {
        results[section.key] = {
          value: jsonLdData.personName,
          confidence: CONFIDENCE.JSON_LD,
          sourceUrl: jsonLdData.personSourceUrl ?? "",
          extractionMethod: "json_ld",
        };
      } else if (sortedPeople[0] && !existing?.value) {
        results[section.key] = {
          value: sortedPeople[0].name,
          confidence: sortedPeople[0].confidence,
          sourceUrl: sortedPeople[0].sourceUrl,
          extractionMethod: "regex",
        };
      }
    }

    // ── Title / Role fields ───────────────────────────────────────────────
    else if (/title|role|position/i.test(section.key + " " + section.label) &&
             /decision.?maker|dm\d|contact|person/i.test(section.key)) {
      if (jsonLdData.personTitle && !existing?.value) {
        results[section.key] = {
          value: jsonLdData.personTitle,
          confidence: CONFIDENCE.JSON_LD,
          sourceUrl: jsonLdData.personSourceUrl ?? "",
          extractionMethod: "json_ld",
        };
      } else if (sortedPeople[0]?.title && !existing?.value) {
        results[section.key] = {
          value: sortedPeople[0].title,
          confidence: sortedPeople[0].confidence,
          sourceUrl: sortedPeople[0].sourceUrl,
          extractionMethod: "regex",
        };
      }
    }

    // ── LinkedIn Personal ─────────────────────────────────────────────────
    else if (/linkedin/i.test(section.key + " " + section.label) &&
             !/company/i.test(section.key + " " + section.label)) {
      if (linkedInPersonal[0] && !existing?.value) {
        results[section.key] = {
          value: linkedInPersonal[0],
          confidence: CONFIDENCE.REGEX_DETERMINISTIC,
          sourceUrl: linkedInPersonal[0],
          extractionMethod: "regex",
        };
      }
    }

    // ── LinkedIn Company ──────────────────────────────────────────────────
    else if (/linkedin.*company|company.*linkedin/i.test(section.key + " " + section.label)) {
      if (linkedInCompany[0] && !existing?.value) {
        results[section.key] = {
          value: linkedInCompany[0],
          confidence: CONFIDENCE.REGEX_DETERMINISTIC,
          sourceUrl: linkedInCompany[0],
          extractionMethod: "regex",
        };
      }
    }

    // ── Phone fields ──────────────────────────────────────────────────────
    else if (/phone|tel/i.test(section.key + " " + section.label)) {
      if (phones[0] && !existing?.value) {
        results[section.key] = {
          value: phones[0],
          confidence: 0.80,
          sourceUrl: "",
          extractionMethod: "regex",
        };
      }
    }

    // ── Company Name ──────────────────────────────────────────────────────
    else if (/company.?name|firm.?name|organisation/i.test(section.key + " " + section.label)) {
      if (jsonLdData.orgName && !existing?.value) {
        results[section.key] = {
          value: jsonLdData.orgName,
          confidence: CONFIDENCE.JSON_LD,
          sourceUrl: jsonLdData.orgSourceUrl ?? "",
          extractionMethod: "json_ld",
        };
      }
    }

    // ── Description / About ───────────────────────────────────────────────
    else if (/description|about|overview|summary/i.test(section.key + " " + section.label)) {
      if (jsonLdData.description && !existing?.value) {
        results[section.key] = {
          value: jsonLdData.description.slice(0, 500),
          confidence: CONFIDENCE.JSON_LD,
          sourceUrl: jsonLdData.orgSourceUrl ?? "",
          extractionMethod: "json_ld",
        };
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Optional LLM Enrichment Pass
// ---------------------------------------------------------------------------

/**
 * Single LLM call to fill remaining gaps after all deterministic extraction.
 * Only fires when critical fields are still empty.
 * Uses gpt-4.1-nano (cheapest model) with a compact prompt.
 * Maximum 1 call per firm.
 */
async function optionalLLMPass(
  pageContents: Array<{ url: string; content: string }>,
  sections: AgentSection[],
  fieldResults: FieldResultMap,
  companyName: string,
  websiteUrl: string,
  skillContext?: SkillContext | null,
): Promise<FieldResultMap> {
  const profile = getProfile();
  const threshold = LLM_GATE_THRESHOLD;

  // Identify fields that are still weak
  const weakFields = sections.filter(s => (fieldResults[s.key]?.confidence ?? 0) < threshold);
  if (weakFields.length === 0) {
    console.log(`[lightweightScraper] LLM pass skipped: all fields above threshold`);
    return fieldResults;
  }

  // Only fire if at least one critical field (email, name, title) is missing
  const criticalMissing = weakFields.some(s =>
    /email|name|title|role|position/i.test(s.key + " " + s.label) &&
    /decision.?maker|dm\d|contact|person/i.test(s.key),
  );
  if (!criticalMissing) {
    console.log(`[lightweightScraper] LLM pass skipped: no critical DM fields missing`);
    return fieldResults;
  }

  // Build compact context from the most relevant pages (contact/team/about first)
  const sortedPages = [...pageContents].sort((a, b) => scoreUrl(b.url) - scoreUrl(a.url));
  const contextChunks = sortedPages
    .slice(0, 3) // Max 3 pages for LLM context
    .map(p => `--- ${p.url} ---\n${p.content.slice(0, 1500)}`)
    .join("\n\n");

  const weakFieldList = weakFields
    .map(s => `${s.key} (${s.label}): ${s.desc || ""}`)
    .join("\n");

  const foundSummary = sections
    .filter(s => (fieldResults[s.key]?.confidence ?? 0) >= threshold)
    .map(s => `${s.label}: "${fieldResults[s.key]?.value ?? ""}"`)
    .join(", ");

  const skillBlock = skillContext
    ? `\nICP: ${skillContext.icpSummary}\nTarget roles: ${skillContext.targetTitles.join(", ")}`
    : "";

  const systemMsg = `You are a B2B data extraction assistant. Extract specific fields from website content.
Return ONLY valid JSON with the exact field keys requested. If a field cannot be found, use "".
Do not invent or hallucinate values. Only extract what is explicitly present in the content.${skillBlock}`;

  const userMsg = `Company: ${companyName}
Website: ${websiteUrl}
Already found: ${foundSummary || "(none)"}

Fields to extract:
${weakFieldList}

Website content:
${contextChunks}

Return JSON with keys: ${weakFields.map(s => s.key).join(", ")}`;

  try {
    console.log(`[lightweightScraper] LLM pass: extracting ${weakFields.length} weak fields for ${companyName}`);
    const response = await queuedLLMCall({
      model: profile.planningModel, // gpt-4.1-nano — cheapest
      messages: [
        { role: "system", content: systemMsg },
        { role: "user", content: userMsg },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");

    const updated = { ...fieldResults };
    for (const section of weakFields) {
      const val = parsed[section.key];
      if (val && typeof val === "string" && val.trim()) {
        updated[section.key] = {
          value: val.trim(),
          confidence: 0.72, // LLM without explicit citation — moderate confidence
          sourceUrl: websiteUrl,
          extractionMethod: "llm_uncited",
        };
      }
    }

    const newlyFilled = weakFields.filter(s => updated[s.key]?.value).length;
    console.log(`[lightweightScraper] LLM pass: filled ${newlyFilled}/${weakFields.length} weak fields`);
    return updated;
  } catch (err) {
    console.warn(`[lightweightScraper] LLM pass failed (non-fatal):`, err);
    return fieldResults;
  }
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Lightweight scraper — drop-in replacement for scrapeUrl() in routers.ts.
 *
 * Same signature as scrapeUrl() for backward compatibility.
 * Returns AgentScrapeResult with the same shape.
 */
export async function scrapeUrlLightweight(
  url: string,
  objective: string,
  sections: AgentSection[],
  systemPrompt: string,
  _maxHops: number, // Ignored — lightweight scraper uses fixed phase structure
  isCancelled?: () => boolean,
  _callbacks?: unknown, // Not used in lightweight mode
  skillContext?: SkillContext | null,
  initialFieldValues?: FieldResultMap,
  knownCompanyName?: string,
): Promise<AgentScrapeResult> {
  const startMs = Date.now();

  const companyName = knownCompanyName?.trim() ||
    (() => { try { return new URL(url).hostname.replace(/^www\./, "").split(".")[0]; } catch { return url; } })();

  const domain = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } })();

  console.log(`[lightweightScraper] Starting: ${companyName} (${url})`);

  // Pre-seed field results from initial values
  let fieldResults: FieldResultMap = {};
  for (const s of sections) {
    fieldResults[s.key] = initialFieldValues?.[s.key] ?? { value: "", confidence: 0.0 };
  }

  // Run preLLMExtract on any pre-seeded values
  if (initialFieldValues && Object.keys(initialFieldValues).length > 0) {
    console.log(`[lightweightScraper] Pre-seeded ${Object.keys(initialFieldValues).length} fields`);
  }

  const extras: Record<string, unknown> = {};
  const pageContents: Array<{ url: string; content: string }> = [];

  // ── PHASE 1: URL DISCOVERY ────────────────────────────────────────────────

  if (isCancelled?.()) throw new Error("JOB_CANCELLED");

  // 1a. Fetch homepage
  console.log(`[lightweightScraper] Phase 1: URL discovery for ${url}`);
  let homepageContent = "";
  try {
    const homepageResult = await fetchViaJina(url);
    if (homepageResult?.success && homepageResult.content) {
      homepageContent = homepageResult.content;
      // Jina returns markdown, not raw HTML — store content as-is
      pageContents.push({ url, content: homepageContent });
    }
  } catch (err) {
    console.warn(`[lightweightScraper] Homepage fetch failed: ${url}`, err);
  }

  // 1b. Sitemap discovery
  const sitemapUrls = await fetchSitemapUrls(url, 30);

  // 1c. Heuristic link discovery from homepage
  const discoveredUrls = homepageContent
    ? discoverRelevantURLs(homepageContent, url, {
        maxTeamPages: 5,
        maxPortfolioPages: 3,
        maxAboutPages: 3,
        includeOther: false,
      }).map(d => d.url)
    : [];

  // 1d. Standard candidate paths
  const standardUrls = generateStandardURLs(url).map(d => d.url);

  // Merge and prioritise all discovered URLs
  const allCandidateUrls = [
    url, // Homepage always first
    ...sitemapUrls,
    ...discoveredUrls,
    ...standardUrls,
    ...STANDARD_PATHS.map(p => {
      try { return new URL(p, url).href; } catch { return ""; }
    }).filter(Boolean),
  ];

  const prioritisedUrls = prioritiseUrls(allCandidateUrls, url, MAX_PAGES);
  // Remove homepage (already fetched)
  const urlsToFetch = prioritisedUrls.filter(u => {
    try {
      const norm = new URL(u).href.replace(/\/$/, "");
      const homeNorm = new URL(url).href.replace(/\/$/, "");
      return norm !== homeNorm;
    } catch { return true; }
  }).slice(0, MAX_PAGES - 1);

  console.log(`[lightweightScraper] Phase 1 complete: ${urlsToFetch.length + 1} URLs to fetch`);

  // ── PHASE 2: PARALLEL PAGE FETCH ─────────────────────────────────────────

  if (isCancelled?.()) throw new Error("JOB_CANCELLED");

  console.log(`[lightweightScraper] Phase 2: Fetching ${urlsToFetch.length} pages (concurrency: ${FETCH_CONCURRENCY})`);

  // Fetch in batches to respect concurrency limit
  for (let i = 0; i < urlsToFetch.length; i += FETCH_CONCURRENCY) {
    if (isCancelled?.()) throw new Error("JOB_CANCELLED");
    const batch = urlsToFetch.slice(i, i + FETCH_CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (pageUrl) => {
        try {
          const result = await fetchViaJina(pageUrl);
          if (result?.success && result.content && result.content.length > 100) {
            return { url: pageUrl, content: result.content };
          }
          return null;
        } catch {
          return null;
        }
      }),
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled" && result.value) {
        pageContents.push(result.value);
      }
    }
  }

  console.log(`[lightweightScraper] Phase 2 complete: ${pageContents.length} pages fetched`);

  // ── PHASE 3: DETERMINISTIC EXTRACTION ────────────────────────────────────

  if (isCancelled?.()) throw new Error("JOB_CANCELLED");

  console.log(`[lightweightScraper] Phase 3: Deterministic extraction from ${pageContents.length} pages`);

  const allEmails: Array<{ email: string; type: "personal" | "generic"; sourceUrl: string }> = [];
  const allPeople: PersonCandidate[] = [];
  const allLinkedInPersonal: string[] = [];
  const allLinkedInCompany: string[] = [];
  const allPhones: string[] = [];
  const jsonLdData: Record<string, string> = {};
  const seenEmailSet = new Set<string>();
  const seenPersonSet = new Set<string>();
  const seenLiPersonal = new Set<string>();
  const seenLiCompany = new Set<string>();

  for (const page of pageContents) {
    // 3a. JSON-LD / Schema.org
    // Jina returns markdown, not raw HTML, so JSON-LD extraction from HTML is not
    // possible here. The preLLMExtractor is called when raw HTML is available
    // (e.g. from Puppeteer fallback). For Jina markdown output, we rely on
    // regex-based extraction in steps 3b-3e below.
    // Note: preLLMExtractFull is still called in agentScraper when rawHtml is present.
    // If we have raw HTML from a hybrid fetch, use it:
    const rawHtml = (page as { url: string; content: string; rawHtml?: string }).rawHtml;
    if (rawHtml) {
      const { fields: preExtracted, companyLinkedinUrl } = preLLMExtractFull(
        rawHtml,
        sections,
        page.url,
      );
      fieldResults = mergeFieldResults(fieldResults, preExtracted);

      if (companyLinkedinUrl && !jsonLdData.companyLinkedIn) {
        jsonLdData.companyLinkedIn = companyLinkedinUrl;
      }

      // Extract JSON-LD org/person data for mapToFieldResults
      try {
        const $ = cheerio.load(rawHtml);
        $('script[type="application/ld+json"]').each((_, el) => {
          try {
            const data = JSON.parse($(el).html() ?? "{}");
            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
              if (!item || typeof item !== "object") continue;
              const type = String(item["@type"] ?? "");
              if ((type === "Organization" || type === "LocalBusiness") && item.name && !jsonLdData.orgName) {
                jsonLdData.orgName = String(item.name);
                jsonLdData.orgSourceUrl = page.url;
                if (item.description) jsonLdData.description = String(item.description);
              }
              if (type === "Person" && item.name && !jsonLdData.personName) {
                jsonLdData.personName = String(item.name);
                if (item.jobTitle) jsonLdData.personTitle = String(item.jobTitle);
                jsonLdData.personSourceUrl = page.url;
              }
            }
          } catch { /* Malformed JSON-LD */ }
        });
      } catch { /* Cheerio parse error */ }
    }

    // 3b. Regex email extraction
    const emails = extractEmailsFromContent(page.content, page.url);
    for (const e of emails) {
      if (!seenEmailSet.has(e.email)) {
        seenEmailSet.add(e.email);
        allEmails.push(e);
      }
    }

    // 3c. LinkedIn URL extraction
    const { personal, company } = extractLinkedInUrls(page.content);
    for (const li of personal) {
      if (!seenLiPersonal.has(li)) { seenLiPersonal.add(li); allLinkedInPersonal.push(li); }
    }
    for (const li of company) {
      if (!seenLiCompany.has(li)) { seenLiCompany.add(li); allLinkedInCompany.push(li); }
    }

    // 3d. Phone extraction
    const phones = extractPhones(page.content);
    allPhones.push(...phones);

    // 3e. Name + title pattern matching
    const people = extractPeopleFromText(page.content, page.url);
    for (const p of people) {
      if (!seenPersonSet.has(p.name.toLowerCase())) {
        seenPersonSet.add(p.name.toLowerCase());
        allPeople.push(p);
      }
    }
  }

  // Map all extracted data to field results
  fieldResults = mapToFieldResults(
    sections,
    allEmails,
    allPeople,
    allLinkedInPersonal,
    allLinkedInCompany,
    [...new Set(allPhones)],
    jsonLdData,
    fieldResults,
  );

  const phase3Filled = sections.filter(s => (fieldResults[s.key]?.confidence ?? 0) >= 0.65).length;
  console.log(`[lightweightScraper] Phase 3 complete: ${phase3Filled}/${sections.length} fields found`);

  // ── PHASE 4: ENRICHMENT CASCADE ───────────────────────────────────────────

  if (isCancelled?.()) throw new Error("JOB_CANCELLED");

  console.log(`[lightweightScraper] Phase 4: Enrichment cascade for ${domain}`);

  // Step 4a: Direct Email Scraper
  // (Already effectively done in Phase 3 — we scraped the same paths.
  //  Run it anyway to catch mailto: links and paths we might have missed.)
  let directScrapeFoundPersonal = allEmails.some(e => e.type === "personal");

  if (!directScrapeFoundPersonal) {
    try {
      const directResult = await scrapeEmailsFromDomain(domain);
      if (directResult.bestPersonal) {
        directScrapeFoundPersonal = true;
        const emailSections = sections.filter(s => /email/i.test(s.key + " " + s.label));
        for (const s of emailSections) {
          if (!fieldResults[s.key]?.value) {
            fieldResults[s.key] = {
              value: directResult.bestPersonal.email,
              confidence: 0.82,
              sourceUrl: `https://${domain}${directResult.bestPersonal.sourcePath}`,
              extractionMethod: "regex",
            };
            break;
          }
        }
        extras["__directEmails"] = directResult.emails;
      } else if (directResult.bestGeneric) {
        const emailSections = sections.filter(s => /email/i.test(s.key + " " + s.label));
        for (const s of emailSections) {
          if (!fieldResults[s.key]?.value) {
            fieldResults[s.key] = {
              value: directResult.bestGeneric.email,
              confidence: 0.65,
              sourceUrl: `https://${domain}${directResult.bestGeneric.sourcePath}`,
              extractionMethod: "regex",
            };
            break;
          }
        }
        extras["__directEmails"] = directResult.emails;
      }
    } catch (err) {
      console.warn(`[lightweightScraper] Direct email scraper failed (non-fatal):`, err);
    }
  }

  // Step 4b: Hunter Domain Search (skip if personal email already found)
  if (!isCancelled?.() && !directScrapeFoundPersonal) {
    try {
      const hunterResult = await hunterDomainSearch(domain, sections, fieldResults);
      if (hunterResult.bestMatch) {
        const hm = hunterResult.bestMatch;
        const sourceUrl = `https://hunter.io/domain-search?domain=${domain}`;
        for (const s of sections) {
          const kl = s.key.toLowerCase();
          const isDm = /decision.?maker|dm\d|contact|person/.test(kl);
          if (isDm && /name/.test(kl) && !fieldResults[s.key]?.value && hm.firstName) {
            fieldResults[s.key] = { value: `${hm.firstName} ${hm.lastName}`.trim(), confidence: 0.82, sourceUrl };
          } else if (isDm && /title|role|position/.test(kl) && !fieldResults[s.key]?.value && hm.position) {
            fieldResults[s.key] = { value: hm.position, confidence: 0.82, sourceUrl };
          } else if (/email/i.test(kl) && !fieldResults[s.key]?.value && hm.value) {
            fieldResults[s.key] = { value: hm.value, confidence: Math.min(0.95, hm.confidence / 100), sourceUrl };
          } else if (isDm && /linkedin/.test(kl) && !fieldResults[s.key]?.value && hm.linkedinUrl) {
            fieldResults[s.key] = { value: hm.linkedinUrl, confidence: 0.88, sourceUrl: hm.linkedinUrl };
          }
        }
        extras["__hunterEmails"] = hunterResult.allEmails;
        console.log(`[lightweightScraper] Hunter merged: ${hm.firstName} ${hm.lastName} <${hm.value}>`);
      }
    } catch (err) {
      console.warn(`[lightweightScraper] Hunter Domain Search failed (non-fatal):`, err);
    }
  }

  // Step 4c: Apify LinkedIn
  if (!isCancelled?.()) {
    try {
      const companyLinkedinUrl = allLinkedInCompany[0] ?? null;
      const targetTitles = skillContext?.targetTitles ?? [];
      const linkedInResult = await enrichWithLinkedIn(
        domain, companyName, sections, fieldResults, companyLinkedinUrl, targetTitles,
      );
      if (linkedInResult.bestMatch) {
        const bm = linkedInResult.bestMatch;
        for (const s of sections) {
          const keyLower = s.key.toLowerCase();
          const isDmField = /decision.?maker|dm\d|contact|person/.test(keyLower);
          if (isDmField && /name/.test(keyLower) && !fieldResults[s.key]?.value) {
            fieldResults[s.key] = { value: bm.name, confidence: 0.85, sourceUrl: bm.linkedinUrl || url };
          } else if (isDmField && /title|role|position/.test(keyLower) && !fieldResults[s.key]?.value) {
            fieldResults[s.key] = { value: bm.title, confidence: 0.85, sourceUrl: bm.linkedinUrl || url };
          } else if (isDmField && /linkedin/.test(keyLower) && !fieldResults[s.key]?.value && bm.linkedinUrl) {
            fieldResults[s.key] = { value: bm.linkedinUrl, confidence: 0.9, sourceUrl: bm.linkedinUrl };
          }
        }
        extras["__linkedInCandidates"] = linkedInResult.allCandidates;
        extras["__linkedInCompanyUrl"] = linkedInResult.linkedInCompanyUrl;
        console.log(`[lightweightScraper] LinkedIn merged: ${bm.name} (${bm.title})`);
      }
    } catch (err) {
      console.warn(`[lightweightScraper] LinkedIn enrichment failed (non-fatal):`, err);
    }
  }

  // Step 4d: SMTP Generic Email Fallback
  if (!isCancelled?.() && shouldRunSmtpFallback(sections, fieldResults)) {
    try {
      const smtpResult = await smtpVerifyGenericEmail(domain);
      if (smtpResult) {
        const sourceUrl = `smtp://${smtpResult.mxHost}:${smtpResult.port}`;
        for (const s of sections) {
          if (/email/i.test(s.key + " " + s.label) && !fieldResults[s.key]?.value) {
            fieldResults[s.key] = {
              value: smtpResult.email,
              confidence: smtpResult.catchAll ? 0.55 : 0.75,
              sourceUrl,
            };
          }
        }
        console.log(`[lightweightScraper] SMTP fallback: ${smtpResult.email}${smtpResult.catchAll ? " (catch-all)" : ""}`);
      }
    } catch (err) {
      console.warn(`[lightweightScraper] SMTP fallback failed (non-fatal):`, err);
    }
  }

  // ── PHASE 5: OPTIONAL LLM PASS ────────────────────────────────────────────

  if (!isCancelled?.()) {
    fieldResults = await optionalLLMPass(
      pageContents,
      sections,
      fieldResults,
      companyName,
      url,
      skillContext,
    );
  }

  // ── BUILD FINAL RESULT ─────────────────────────────────────────────────────

  const data: Record<string, string> = {};
  for (const s of sections) {
    data[s.key] = fieldResults[s.key]?.value ?? "";
  }

  const emptyFields = sections.map(s => s.key).filter(k => !data[k] || data[k].trim() === "");
  const stats: ScrapeStats = {
    fieldsTotal: sections.length,
    fieldsFilled: sections.length - emptyFields.length,
    emptyFields,
  };

  const filledCount = sections.filter(s => (fieldResults[s.key]?.confidence ?? 0) >= 0.65).length;
  const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(
    `[lightweightScraper] ✅ Done: ${pageContents.length} pages, ` +
    `${filledCount}/${sections.length} fields confident, ` +
    `${stats.fieldsFilled}/${sections.length} non-empty, ${durationSec}s`,
  );

  return {
    type: "profile",
    data,
    fieldResults,
    stats,
    ...(Object.keys(extras).length > 0 ? { extras } : {}),
  };
}
