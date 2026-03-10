/**
 * Agentic Scraper — Plan-Act-Observe-Reflect Loop
 *
 * Replaces the old fixed pipeline (fetch → classify → extract → 5 hops → done)
 * with a true agent loop that:
 *
 *   1. PLAN   — LLM decides the next action (fetch_url | web_search | done)
 *   2. ACT    — Execute the action
 *   3. OBSERVE — Extract all fields from the result, score confidence per field
 *   4. REFLECT — If all fields are confident enough, stop. Otherwise, loop.
 *
 * Key improvements over the old pipeline:
 *   - No classifyPage() — the agent never misclassifies a company site as a directory
 *   - Web search fallback — if the website has no data, search the web
 *   - Per-field confidence scoring — stops when it has enough, not when a counter hits 0
 *   - Source attribution — every field value records which URL it came from
 *   - Intent-aware — always knows it is enriching a specific company, not crawling
 *
 * The old classifyPage / directory-expansion path is preserved as a separate
 * opt-in export (scrapeUrlAsDirectory) for the "Collected URLs" tab use-case.
 */

import { fetchViaJina, fetchWebsiteContentHybrid } from "./jinaFetcher";
import { extractDirectory, type DirectoryEntry as DirEntry } from "./directoryExtractor";
import { queuedLLMCall } from "./_core/llmQueue";
import { webSearch, searchQueryForField } from "./_core/webSearch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentSection {
  key: string;
  label: string;
  desc: string;
}

export interface DirectoryEntry {
  name: string;
  directoryUrl: string;
  nativeUrl?: string;
}

export interface ScrapeStats {
  fieldsTotal: number;
  fieldsFilled: number;
  emptyFields: string[];
}

/**
 * Per-field extraction result with a confidence score.
 * confidence: 0.0 = not found / guessed, 1.0 = explicitly stated on page.
 * The agent loop uses this to decide whether to keep searching.
 */
export interface FieldResult {
  value: string;
  confidence: number; // 0.0 – 1.0
  sourceUrl?: string; // which URL this value was extracted from
}

/** Map of field key → FieldResult */
export type FieldResultMap = Record<string, FieldResult>;

/** Confidence threshold: fields below this are considered "needs more search" */
export const CONFIDENCE_THRESHOLD = 0.7;

export type AgentScrapeResult =
  | { type: "directory"; entries: DirectoryEntry[] }
  | { type: "profile"; data: Record<string, string>; fieldResults: FieldResultMap; stats: ScrapeStats };

// ---------------------------------------------------------------------------
// Agent action types
// ---------------------------------------------------------------------------

type AgentAction =
  | { action: "fetch_url"; target: string; reason: string }
  | { action: "web_search"; query: string; reason: string }
  | { action: "done"; reason: string };

// ---------------------------------------------------------------------------
// 1. PLAN — LLM decides what to do next
// ---------------------------------------------------------------------------

async function planNextAction(
  companyName: string,
  websiteUrl: string,
  objective: string,
  sections: AgentSection[],
  fieldResults: FieldResultMap,
  visitedUrls: Set<string>,
  availableLinks: string[],
  hopsUsed: number,
  maxHops: number,
): Promise<AgentAction> {
  // Build a summary of current state
  const fieldSummary = sections.map(s => {
    const r = fieldResults[s.key];
    const conf = r ? r.confidence.toFixed(2) : "0.00";
    const val = r?.value ? `"${r.value.slice(0, 60)}${r.value.length > 60 ? "..." : ""}"` : "(empty)";
    return `  ${s.key} [conf=${conf}]: ${val}`;
  }).join("\n");

  const weakFields = sections.filter(s => (fieldResults[s.key]?.confidence ?? 0) < CONFIDENCE_THRESHOLD);
  const allDone = weakFields.length === 0;

  if (allDone || hopsUsed >= maxHops) {
    return { action: "done", reason: allDone ? "All fields have sufficient confidence" : "Max hops reached" };
  }

  const visitedList = [...visitedUrls].slice(-10).join("\n  ");
  const linkList = availableLinks.slice(0, 20).join("\n  ");
  const weakList = weakFields.map(s => `${s.key} (${s.label})`).join(", ");

  const prompt = `You are an AI agent enriching data for a company. Your goal is to fill in all required fields with high confidence.

Company: ${companyName}
Website: ${websiteUrl}
Objective: ${objective}

Current field values and confidence scores (0.0 = not found, 1.0 = certain):
${fieldSummary}

Fields still needing data (confidence < ${CONFIDENCE_THRESHOLD}): ${weakList}

URLs already visited (do not repeat):
  ${visitedList || "(none yet)"}

Available links on the last page visited:
  ${linkList || "(none)"}

Hops used: ${hopsUsed} / ${maxHops}

Decide the SINGLE best next action:
- "fetch_url": fetch one of the available links that is most likely to contain the missing fields
- "web_search": search the web for the missing data (use when website has no useful links left)
- "done": stop if you believe no more data can be found

Rules:
- NEVER fetch a URL that is already in the visited list
- Prefer fetch_url over web_search when good links are available
- Use web_search when the website is thin, blocked, or has no relevant links
- Choose "done" if all weak fields are unlikely to be found anywhere

Return ONLY valid JSON:
{"action":"fetch_url"|"web_search"|"done","target":"url if fetch_url else null","query":"search query if web_search else null","reason":"one sentence"}`;

  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: prompt }],
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
      // Validate the URL is not already visited
      if (visitedUrls.has(parsed.target)) {
        console.log(`[agentScraper] PLAN: LLM chose already-visited URL, switching to web_search`);
        const weakField = weakFields[0];
        return {
          action: "web_search",
          query: searchQueryForField(companyName, websiteUrl, weakField.label),
          reason: "Chosen URL already visited, falling back to web search",
        };
      }
      return { action: "fetch_url", target: parsed.target, reason: parsed.reason ?? "" };
    }

    if (parsed.action === "web_search") {
      const query = parsed.query || searchQueryForField(companyName, websiteUrl, weakFields[0]?.label ?? "company info");
      return { action: "web_search", query, reason: parsed.reason ?? "" };
    }

    return { action: "done", reason: parsed.reason ?? "LLM decided done" };
  } catch (err) {
    console.error("[agentScraper] planNextAction error:", err instanceof Error ? err.message : String(err).slice(0, 200));
    return { action: "done", reason: "Planning error — stopping safely" };
  }
}

// ---------------------------------------------------------------------------
// 2. OBSERVE — extract fields from page content (with confidence + source)
// ---------------------------------------------------------------------------

async function extractProfileFields(
  content: string,
  sections: AgentSection[],
  systemPrompt: string,
  sourceUrl?: string,
  pageType?: "directory" | "company" | "search",
): Promise<FieldResultMap> {
  // Build per-section schema properties — each field now returns value + confidence
  const props: Record<string, { type: string; properties?: object; required?: string[]; additionalProperties?: boolean; description?: string }> = {};
  for (const s of sections) {
    props[s.key] = {
      type: "object",
      description: `${s.label}: ${s.desc}`,
      properties: {
        value: { type: "string" },
        confidence: { type: "number" },
      },
      required: ["value", "confidence"],
      additionalProperties: false,
    };
  }

  // Build a brief example from the first 2 sections so the LLM sees expected format
  const exampleObj: Record<string, { value: string; confidence: number }> = {};
  for (const s of sections.slice(0, 2)) {
    exampleObj[s.key] = { value: `[extracted ${s.label.toLowerCase()} from page]`, confidence: 0.9 };
  }
  for (const s of sections.slice(2)) {
    exampleObj[s.key] = { value: "", confidence: 0.0 };
  }
  const exampleJson = JSON.stringify(exampleObj, null, 2);

  // Build page-type-specific extraction guidance so the LLM assigns
  // appropriate confidence to data from each source type.
  let pageTypeGuidance = "";
  if (pageType === "directory") {
    pageTypeGuidance = `
PAGE TYPE: Business directory profile (e.g. Clutch, G2, GoodFirms, Yelp, Capterra)

Directories contain HIGHLY RELIABLE structured data for operational fields:
  - Employee count, company size tier (e.g. "10-49") → confidence 0.95
  - Hourly rate / pricing range (e.g. "$150-$199/hr") → confidence 0.95
  - Min project size (e.g. "$10,000+") → confidence 0.95
  - Year founded (e.g. "Founded 2009") → confidence 0.95
  - Headquarters / office locations → confidence 0.95
  - Service lines and focus areas with percentages → confidence 0.90
  - Company description / About text → confidence 0.85
  - Clutch rating and review count → confidence 0.95
  - Business entity name (legal name) → confidence 0.95

Directories contain UNRELIABLE or ABSENT data for:
  - Individual contact names and titles → confidence 0.2 (directories rarely list staff)
  - Email addresses → confidence 0.1 (almost never shown)
  - Direct phone numbers → confidence 0.3
  - Specific technology stack details → confidence 0.3

Assign HIGH confidence (0.9+) to operational fields that are explicitly shown in
structured directory fields (not in client reviews or testimonials).
Assign LOW confidence (0.1–0.3) to contact/personnel fields even if a name appears,
because it is likely a reviewer or client, not an employee.`;
  } else if (pageType === "search") {
    pageTypeGuidance = `
PAGE TYPE: Web search result snippets
Data is partial and may be out of date. Assign confidence 0.4–0.6 for any field
extracted from snippets. Only assign 0.7+ if the snippet explicitly states the value.`;
  } else {
    pageTypeGuidance = `
PAGE TYPE: Company's own website
This is the most authoritative source for contact names, team members, services
description, and company culture. Assign confidence 0.9+ for fields explicitly
stated here. Employee count and pricing are rarely on company websites — assign
0.0 if not found rather than guessing.`;
  }

  // Build decision-maker priority guidance based on whether the system prompt
  // mentions a specific partnership context (e.g. Calibre Consulting = tech partner for agencies)
  const dmPriorityGuidance = `
DECISION MAKER SELECTION RULES (apply when extracting contact / decision maker fields):

Step 1 — Identify ALL people mentioned on this page who are employees of THIS company.
  - EXCLUDE: client names, testimonial authors, case study subjects, partner company staff, reviewers
  - INCLUDE: founders, owners, C-suite, directors, managers, developers, designers, strategists

Step 2 — Rank candidates by their likelihood to approve a B2B technology partnership:
  TIER 1 (most likely decision maker — pick first):
    CEO, Founder, Co-Founder, Owner, President, Managing Director, Managing Partner,
    Principal, Executive Director, Chief Executive Officer
  TIER 2 (technical/digital decision maker — pick if no Tier 1 available):
    CTO, Chief Technology Officer, VP Engineering, VP Technology, VP Digital,
    Director of Technology, Head of Technology, Senior Developer, Lead Developer,
    Technical Director, Director of Development, Head of Development,
    VP Product, Head of Product, Director of Digital
  TIER 3 (operational decision maker — pick if no Tier 1 or 2 available):
    COO, VP Operations, Director of Operations, General Manager,
    VP Client Services, Director of Client Services, Account Director,
    VP Strategy, Director of Strategy, Head of Strategy
  TIER 4 (creative/marketing — only if no higher tier available):
    Creative Director, Art Director, Design Director, Marketing Director,
    Brand Director, Content Director, Head of Creative
  TIER 5 (individual contributors — last resort only):
    Designer, Developer, Project Manager, Account Manager, Coordinator

Step 3 — When multiple people are at the same tier, prefer:
  - More senior title ("Senior" > "Junior", "Director" > "Manager")
  - Person with most complete information (name + title both present)
  - Person listed first on the page

Step 4 — For Decision Maker 1: pick the highest-tier person
         For Decision Maker 2: pick the second-highest-tier person (different from DM1)
         For Decision Maker 3: pick the third-highest-tier person (different from DM1 and DM2)

IMPORTANT: A "Creative Director" or "Art Director" should NEVER be chosen over a CEO, CTO,
or Senior Developer when those roles are available. Technical and executive roles outrank
creative roles for B2B technology partnership decisions.`;

  const userMsg = `${systemPrompt}${pageTypeGuidance}${dmPriorityGuidance}

Page content:
${content.substring(0, 60000)}

Extract each field about THIS company only (the entity being profiled on this page).
Ignore client testimonials, reviewer names, case study client companies, partner logos, and any third-party content.
Be specific and concrete — use actual data from the page, not summaries.

For each field, return:
- "value": the extracted text, or "" if not found
- "confidence": a score from 0.0 to 1.0:
    1.0 = explicitly and clearly stated on the page
    0.7 = strongly implied or inferable from context
    0.4 = partially found or uncertain
    0.0 = not found on this page

Example output format:
${exampleJson}

Return ONLY valid JSON with these keys: ${sections.map((s) => s.key).join(", ")}`;

  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: userMsg }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "field_extraction",
          strict: true,
          schema: {
            type: "object",
            properties: props,
            required: sections.map((s) => s.key),
            additionalProperties: false,
          },
        },
      },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");

    // Build FieldResultMap — ensure all section keys are present
    const result: FieldResultMap = {};
    for (const s of sections) {
      const field = parsed[s.key];
      const value = String(field?.value ?? "").trim();
      const confidence = typeof field?.confidence === "number"
        ? Math.max(0, Math.min(1, field.confidence))
        : value ? 0.5 : 0.0; // fallback: non-empty = 0.5, empty = 0.0
      result[s.key] = { value, confidence, sourceUrl };
    }
    return result;
  } catch (err) {
    console.error("[agentScraper] extractProfileFields error:", err instanceof Error ? err.message : String(err).slice(0, 200));
    const empty: FieldResultMap = {};
    for (const s of sections) empty[s.key] = { value: "", confidence: 0.0, sourceUrl };
    return empty;
  }
}

// ---------------------------------------------------------------------------
// 3. REFLECT — merge two FieldResultMaps, keeping the higher-confidence value
// ---------------------------------------------------------------------------

function mergeFieldResults(base: FieldResultMap, incoming: FieldResultMap): FieldResultMap {
  const merged: FieldResultMap = { ...base };
  for (const [key, incomingResult] of Object.entries(incoming)) {
    const existing = merged[key];
    if (!existing) { merged[key] = incomingResult; continue; }

    const incomingVal = incomingResult.value?.trim() ?? "";
    const existingVal = existing.value?.trim() ?? "";

    // If incoming is empty, keep existing
    if (!incomingVal) continue;

    // If existing is empty, use incoming
    if (!existingVal) { merged[key] = incomingResult; continue; }

    // Both have content — prefer higher confidence
    if (incomingResult.confidence > existing.confidence) {
      merged[key] = incomingResult;
      continue;
    }

    // Same confidence — prefer longer (more complete) value
    if (incomingResult.confidence === existing.confidence && incomingVal.length > existingVal.length) {
      merged[key] = incomingResult;
      continue;
    }

    // Append if incoming adds genuinely new information (not a substring)
    const existingLower = existingVal.toLowerCase();
    const incomingLower = incomingVal.toLowerCase();
    if (!existingLower.includes(incomingLower) && !incomingLower.includes(existingLower)) {
      // Combine, keeping the higher-confidence source attribution
      const combinedValue = `${existingVal}; ${incomingVal}`;
      const combinedConf = Math.max(existing.confidence, incomingResult.confidence);
      merged[key] = { value: combinedValue, confidence: combinedConf, sourceUrl: existing.sourceUrl };
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 4a. Directory-exit helpers — extract the company's real website from a
//     directory profile page before generic link extraction runs.
// ---------------------------------------------------------------------------

/**
 * Known directory domains and their redirect/website-link patterns.
 * For each directory, we define:
 *   - domains: hostnames that identify this directory
 *   - extractWebsite: function that extracts the company's real URL from raw page content
 */
const DIRECTORY_EXTRACTORS: Array<{
  name: string;
  domains: string[];
  extractWebsite: (content: string) => string | null;
}> = [
  {
    // Clutch: wraps links as https://r.clutch.co/redirect?...&provider_website=tbkcreative.com&...&u=http%3A%2F%2F...
    // The `provider_website` param is the cleanest signal; `u=` param has the full URL.
    name: "Clutch",
    domains: ["clutch.co"],
    extractWebsite: (content) => {
      // Strategy 1: extract from `u=` query param inside a Clutch redirect URL (most reliable)
      const uMatch = content.match(/[?&]u=(https?[^&"'\s>)]+)/);
      if (uMatch) {
        try {
          const decoded = new URL(decodeURIComponent(uMatch[1]));
          decoded.searchParams.delete("utm_source");
          decoded.searchParams.delete("utm_medium");
          decoded.searchParams.delete("utm_campaign");
          return decoded.origin + decoded.pathname;
        } catch { /* fall through */ }
      }
      // Strategy 2: extract from `provider_website=` param (domain only — prepend https://)
      const pwMatch = content.match(/provider_website=([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (pwMatch) return `https://${pwMatch[1]}`;
      return null;
    },
  },
  {
    // GoodFirms: company website appears as plain text after "Website:" or as a bare URL
    // in the company info section. GoodFirms does NOT use redirect URLs.
    name: "GoodFirms",
    domains: ["goodfirms.co"],
    extractWebsite: (content) => {
      // Look for "Website: https://..." pattern in the markdown
      const m = content.match(/Website[:\s]+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?)/);
      if (m) return m[1].startsWith("http") ? m[1] : `https://${m[1]}`;
      return null;
    },
  },
  {
    // G2: company website is in a "Visit website" button or "Website" field.
    // G2 uses a redirect: https://www.g2.com/products/X/go?utm_source=...
    name: "G2",
    domains: ["g2.com"],
    extractWebsite: (content) => {
      // G2 redirect: /go?utm_source=... does not contain the target URL in the link itself.
      // Fall back to looking for a bare domain after "Website" label.
      const m = content.match(/(?:Website|website)[:\s]+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (m && !m[1].includes("g2.com")) return `https://${m[1]}`;
      return null;
    },
  },
  {
    // Yelp: company website is in a "Business website" link, sometimes obfuscated via
    // https://www.yelp.com/biz_redir?url=https%3A%2F%2F...
    name: "Yelp",
    domains: ["yelp.com"],
    extractWebsite: (content) => {
      // Strategy 1: biz_redir URL
      const redirMatch = content.match(/biz_redir\?url=(https?[^&"'\s>)]+)/);
      if (redirMatch) {
        try { return decodeURIComponent(redirMatch[1]); } catch { /* fall through */ }
      }
      // Strategy 2: plain text after "Business website"
      const m = content.match(/Business website[:\s]+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (m) return `https://${m[1]}`;
      return null;
    },
  },
  {
    // Capterra: uses /goto/software/... redirect links
    name: "Capterra",
    domains: ["capterra.com"],
    extractWebsite: (content) => {
      // Capterra does not embed the target URL in the redirect path.
      // Fall back to looking for a bare domain after "Website" label.
      const m = content.match(/(?:Website|website)[:\s]+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (m && !m[1].includes("capterra.com")) return `https://${m[1]}`;
      return null;
    },
  },
  {
    // Trustpilot: company website in the business info section
    name: "Trustpilot",
    domains: ["trustpilot.com"],
    extractWebsite: (content) => {
      const m = content.match(/(?:Website|website)[:\s]+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (m && !m[1].includes("trustpilot.com")) return `https://${m[1]}`;
      return null;
    },
  },
];

/**
 * Given a directory page URL and its content, attempt to extract the company's
 * real website URL using directory-specific logic.
 * Returns null if the URL is not a known directory or no website is found.
 */
export function extractCompanyWebsiteFromDirectory(pageUrl: string, content: string): string | null {
  let host = "";
  try { host = new URL(pageUrl).hostname; } catch { return null; }

  for (const extractor of DIRECTORY_EXTRACTORS) {
    if (extractor.domains.some(d => host.includes(d))) {
      const website = extractor.extractWebsite(content);
      if (website) {
        console.log(`[agentScraper] 🏠 ${extractor.name} directory-exit: found company website → ${website}`);
        return website;
      }
    }
  }
  return null;
}

/**
 * Returns true if the given URL is a known directory profile page.
 */
export function isDirectoryUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return DIRECTORY_EXTRACTORS.some(e => e.domains.some(d => host.includes(d)));
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// 4b. Extract available links from page content (for PLAN step)
// ---------------------------------------------------------------------------

function extractLinksFromContent(content: string, baseUrl: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();

  // Noise domains: images, CDNs, social media, and all known directory domains.
  // Links to these are deprioritised or filtered out.
  const noiseDomains = [
    'shgstatic.com', 'cloudfront.net', 'amazonaws.com', 'googleusercontent.com',
    'facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 'instagram.com',
    'youtube.com', 'tiktok.com', 'pinterest.com',
    ...DIRECTORY_EXTRACTORS.flatMap(e => e.domains),
  ];
  const isNoise = (u: string) => {
    try { const h = new URL(u).hostname; return noiseDomains.some(d => h.includes(d)); }
    catch { return true; }
  };

  function addLink(raw: string) {
    let url = raw.replace(/[.,;)>\]"']+$/, "");
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;

      // ── Directory redirect decoding ──────────────────────────────────────
      // Clutch: extract from u= param
      if (host.includes("clutch.co")) {
        const uParam = parsed.searchParams.get("u");
        if (uParam) {
          try {
            const decoded = new URL(decodeURIComponent(uParam));
            decoded.searchParams.delete("utm_source");
            decoded.searchParams.delete("utm_medium");
            decoded.searchParams.delete("utm_campaign");
            url = decoded.origin + decoded.pathname;
          } catch { return; }
        } else {
          return; // internal Clutch link — skip
        }
      }
      // Yelp: extract from biz_redir?url=
      else if (host.includes("yelp.com") && parsed.pathname.includes("biz_redir")) {
        const target = parsed.searchParams.get("url");
        if (target) {
          try { url = decodeURIComponent(target); } catch { return; }
        } else { return; }
      }
      // Generic: skip obvious noise (images, CDN, social)
      else if (isNoise(url)) {
        return;
      }
    } catch { return; }

    if (!seen.has(url)) { seen.add(url); links.push(url); }
  }

  // Match markdown-style links: [text](url)
  const mdPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdPattern.exec(content)) !== null) {
    addLink(m[2]);
  }

  // Match bare URLs
  const barePattern = /https?:\/\/[^\s"'<>)\]]+/g;
  while ((m = barePattern.exec(content)) !== null) {
    addLink(m[0]);
  }

  // ── Prioritization ───────────────────────────────────────────────────────
  let baseDomain = "";
  try { baseDomain = new URL(baseUrl).hostname; } catch { /* ignore */ }

  // Tier 1: sub-pages of the same domain as baseUrl (e.g. /about, /team, /contact)
  const sameDomain = links.filter(u => {
    try { return new URL(u).hostname === baseDomain; } catch { return false; }
  });

  // Tier 2: company's own external site (not a directory, not noise)
  const companyLinks = links.filter(u => !sameDomain.includes(u));

  // Within Tier 2, prefer high-value sub-pages (about, team, contact, leadership)
  const HIGH_VALUE_PATHS = ['/about', '/team', '/contact', '/leadership', '/people', '/staff', '/management', '/founders', '/executives'];
  const highValue = companyLinks.filter(u => {
    try { const p = new URL(u).pathname.toLowerCase(); return HIGH_VALUE_PATHS.some(h => p.startsWith(h)); }
    catch { return false; }
  });
  const otherCompany = companyLinks.filter(u => !highValue.includes(u));

  // Order: same-domain sub-pages → high-value company pages → other company pages
  return [...sameDomain, ...highValue, ...otherCompany].slice(0, 50);
}

// ---------------------------------------------------------------------------
// 5. Fetch a URL and return content + extracted links
// ---------------------------------------------------------------------------

async function fetchAndExtract(url: string): Promise<{ content: string; links: string[] } | null> {
  const result = await fetchWebsiteContentHybrid(url, async () => {
    try {
      const { scrapeWebsite } = await import("./scraper");
      const r = await scrapeWebsite({ url, cache: true, cacheTTL: 7 * 24 * 60 * 60, timeout: 45000 });
      return r.success ? r.text || r.html || null : null;
    } catch { return null; }
  });

  if (!result?.success || !result.content) return null;
  const links = extractLinksFromContent(result.content, url);
  return { content: result.content, links };
}

// ---------------------------------------------------------------------------
// 6. Main entry point — Plan-Act-Observe-Reflect loop
// ---------------------------------------------------------------------------

/**
 * Scrape a URL with the given objective + custom sections.
 *
 * This is the new agentic implementation. It runs a Plan-Act-Observe-Reflect
 * loop per company, stopping when all fields have sufficient confidence or
 * the hop limit is reached.
 *
 * The optional `isCancelled` callback is checked at every loop iteration.
 */
export async function scrapeUrl(
  url: string,
  objective: string,
  sections: AgentSection[],
  systemPrompt: string,
  maxHops = 8,
  isCancelled?: () => boolean,
): Promise<AgentScrapeResult> {
  console.log(`[agentScraper] 🚀 Starting agent loop: ${url}`);

  // Extract company name from URL for search queries
  let companyName = "";
  try { companyName = new URL(url).hostname.replace(/^www\./, "").split(".")[0]; } catch { companyName = url; }

  // Agent state
  let fieldResults: FieldResultMap = {};
  for (const s of sections) fieldResults[s.key] = { value: "", confidence: 0.0 };

  const visitedUrls = new Set<string>();
  let availableLinks: string[] = [];
  let hopsUsed = 0;

  // ── STEP 0: Fetch the primary URL first (always) ──────────────────────────
  console.log(`[agentScraper] Fetching primary URL: ${url}`);
  const primary = await fetchAndExtract(url);

  if (!primary) {
    console.warn(`[agentScraper] ❌ Primary URL fetch failed: ${url} — will rely on web search`);
  } else {
    visitedUrls.add(url);
    availableLinks = primary.links;

    if (sections.length > 0) {
      const extracted = await extractProfileFields(
        primary.content, sections, systemPrompt, url,
        isDirectoryUrl(url) ? "directory" : "company",
      );
      fieldResults = mergeFieldResults(fieldResults, extracted);
      const filled = sections.filter(s => (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD).length;
      console.log(`[agentScraper] Primary page: ${filled}/${sections.length} fields confident`);
    }
    hopsUsed++;

    // ── DIRECTORY-EXIT FAST PATH ─────────────────────────────────────────────
    // If the primary URL is a known directory (Clutch, G2, GoodFirms, etc.),
    // extract the company's real website URL immediately and inject it at the
    // FRONT of availableLinks so the agent visits it on the very next hop.
    // This avoids wasting hops on planNextAction trying to figure out where to go.
    if (isDirectoryUrl(url)) {
      const companyWebsite = extractCompanyWebsiteFromDirectory(url, primary.content);
      if (companyWebsite && !visitedUrls.has(companyWebsite)) {
        // Inject at front so it is the first link the planner sees
        availableLinks = [companyWebsite, ...availableLinks.filter(l => l !== companyWebsite)];
        console.log(`[agentScraper] 📌 Directory-exit: injected company website at top of queue: ${companyWebsite}`);
      }
    }
  }

  // ── AGENT LOOP ─────────────────────────────────────────────────────────────
  while (hopsUsed < maxHops) {
    // Check cancellation at the top of every loop iteration
    if (isCancelled?.()) throw new Error("JOB_CANCELLED");

    // PLAN — decide what to do next
    const plan = await planNextAction(
      companyName,
      url,
      objective,
      sections,
      fieldResults,
      visitedUrls,
      availableLinks,
      hopsUsed,
      maxHops,
    );

    console.log(`[agentScraper] PLAN [hop ${hopsUsed}/${maxHops}]: ${plan.action} — ${plan.reason}`);

    if (plan.action === "done") break;

    // ACT
    if (plan.action === "fetch_url") {
      if (isCancelled?.()) throw new Error("JOB_CANCELLED");

      const fetched = await fetchAndExtract(plan.target);
      hopsUsed++;

      if (!fetched) {
        console.warn(`[agentScraper] ⚠️ fetch_url failed: ${plan.target}`);
        availableLinks = availableLinks.filter(l => l !== plan.target);
        continue;
      }

      visitedUrls.add(plan.target);
      availableLinks = [...new Set([...availableLinks, ...fetched.links])].filter(l => !visitedUrls.has(l));

      // OBSERVE
      if (isCancelled?.()) throw new Error("JOB_CANCELLED");
      const fetchPageType = isDirectoryUrl(plan.target) ? "directory" : "company";
      const extracted = await extractProfileFields(fetched.content, sections, systemPrompt, plan.target, fetchPageType);

      // REFLECT — merge, keeping higher-confidence values
      fieldResults = mergeFieldResults(fieldResults, extracted);
      const filled = sections.filter(s => (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD).length;
      console.log(`[agentScraper] After fetch_url (${fetchPageType}): ${filled}/${sections.length} fields confident`);

    } else if (plan.action === "web_search") {
      if (isCancelled?.()) throw new Error("JOB_CANCELLED");

      console.log(`[agentScraper] 🔍 Web search: "${plan.query}"`);
      const searchResults = await webSearch(plan.query, 5);
      hopsUsed++;

      if (searchResults.length === 0) {
        console.warn(`[agentScraper] Web search returned no results`);
        continue;
      }

      // Fetch the top search result that hasn't been visited
      const topResult = searchResults.find(r => !visitedUrls.has(r.url));
      if (!topResult) continue;

      if (isCancelled?.()) throw new Error("JOB_CANCELLED");
      const fetched = await fetchAndExtract(topResult.url);

      if (!fetched) {
        // Use the snippet directly as content if the page can't be fetched
        const snippetContent = searchResults.map(r => `${r.title}\n${r.snippet}`).join("\n\n");
        visitedUrls.add(topResult.url);
        const extracted = await extractProfileFields(snippetContent, sections, systemPrompt, topResult.url, "search");
        fieldResults = mergeFieldResults(fieldResults, extracted);
      } else {
        visitedUrls.add(topResult.url);
        availableLinks = [...new Set([...availableLinks, ...fetched.links])].filter(l => !visitedUrls.has(l));
        if (isCancelled?.()) throw new Error("JOB_CANCELLED");
        const searchPageType = isDirectoryUrl(topResult.url) ? "directory" : "company";
        const extracted = await extractProfileFields(fetched.content, sections, systemPrompt, topResult.url, searchPageType);
        fieldResults = mergeFieldResults(fieldResults, extracted);
      }

      const filled = sections.filter(s => (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD).length;
      console.log(`[agentScraper] After web_search: ${filled}/${sections.length} fields confident`);
    }
  }

  // ── BUILD FINAL RESULT ─────────────────────────────────────────────────────
  // Flatten fieldResults into plain data map (backward compatible)
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

  const filledCount = sections.filter(s => (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD).length;
  console.log(
    `[agentScraper] ✅ Done: ${visitedUrls.size} pages visited, ` +
    `${filledCount}/${sections.length} fields confident, ` +
    `${stats.fieldsFilled}/${sections.length} fields non-empty`
  );

  return { type: "profile", data, fieldResults, stats };
}

// ---------------------------------------------------------------------------
// 7. Directory scraping — preserved as opt-in for "Collected URLs" tab
// ---------------------------------------------------------------------------

/**
 * Scrape a URL as a directory (listing page).
 * Only used when the user explicitly provides a directory URL in their input.
 * This is NOT called automatically during profile enrichment.
 */
export async function scrapeUrlAsDirectory(
  url: string,
  objective: string,
): Promise<AgentScrapeResult> {
  console.log(`[agentScraper] Directory mode: ${url}`);

  const KNOWN_DIRECTORIES = ['goodfirms.co', 'clutch.co', 'g2.com', 'yelp.com', 'capterra.com', 'trustpilot.com'];
  const urlHost = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  const isKnownDir = KNOWN_DIRECTORIES.some(d => urlHost.includes(d));

  // Fetch and do a quick LLM check to confirm it's actually a directory
  const fetched = await fetchAndExtract(url);
  if (!fetched) {
    return { type: "directory", entries: [] };
  }

  // Quick heuristic: if it's a known directory domain, trust it
  // Otherwise, do a fast LLM check
  let isDirectory = isKnownDir;
  if (!isKnownDir) {
    try {
      const checkPrompt = `Is this page a listing/directory of multiple companies or entities, or is it a single company's own website?
URL: ${url}
Content (first 3000 chars): ${fetched.content.substring(0, 3000)}
Return ONLY: {"isDirectory":true|false}`;
      const resp = await queuedLLMCall({
        messages: [{ role: "user", content: checkPrompt }],
        response_format: { type: "json_schema", json_schema: { name: "dir_check", strict: true, schema: { type: "object", properties: { isDirectory: { type: "boolean" } }, required: ["isDirectory"], additionalProperties: false } } },
      });
      const raw = resp.choices[0]?.message?.content ?? "{}";
      isDirectory = JSON.parse(typeof raw === "string" ? raw : "{}").isDirectory ?? false;
    } catch { isDirectory = false; }
  }

  if (!isDirectory) {
    console.log(`[agentScraper] URL is not a directory — use scrapeUrl() for profile enrichment`);
    return { type: "directory", entries: [] };
  }

  const dirResult = await extractDirectory(url, {
    entryLabel: objective || "entities",
    maxPages: 500,
    delayMs: 500,
  });

  const entries: DirectoryEntry[] = dirResult.entries.map((e: DirEntry) => ({
    name: e.name,
    directoryUrl: e.url,
    nativeUrl: undefined,
  }));

  console.log(`[agentScraper] Directory: ${entries.length} entries found`);
  return { type: "directory", entries };
}
