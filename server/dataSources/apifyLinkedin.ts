/**
 * Apify LinkedIn Company Employees — harvestapi/linkedin-company-employees
 *
 * Smart enrichment flow:
 *   1. Check confidence gate — skip if website already gave us high-confidence DM data
 *   2. Use LinkedIn company URL from preLLMExtractor if found (free, no API call)
 *   3. If no URL found, search for it via SERP (one web search, no Apify cost)
 *   4. Call Apify actor with title filter + maxItems cap to avoid runaway costs
 *   5. LLM re-ranking step — pick the best candidate from the returned pool
 *
 * Cost safeguards:
 *   - Confidence gate: skip entirely if website data is already high-confidence
 *   - maxItems capped at APIFY_MAX_EMPLOYEES env var (default 10)
 *   - Title filter: only pull profiles matching target roles (not all employees)
 *   - No retry on failure: log and return empty to avoid double-billing
 *
 * Gate: APIFY_API_KEY env var — returns null when absent (graceful no-op).
 */

import { webSearch } from "../_core/webSearch";
import { queuedLLMCall } from "../_core/llmQueue";
import type { AgentSection, FieldResultMap } from "../agentScraper";
import { CONFIDENCE_THRESHOLD } from "../agentScraper";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LinkedInPerson {
  firstName: string;
  lastName: string;
  name: string;
  title: string;
  linkedinUrl: string;
  seniority: string;
  /** Relevance score assigned by the LLM re-ranker (0–1). Higher = better match. */
  relevanceScore?: number;
}

export interface LinkedInEnrichmentResult {
  /** Best-matched decision maker from the candidate pool. Null if no good match found. */
  bestMatch: LinkedInPerson | null;
  /** Full candidate pool returned by Apify (up to maxItems). */
  allCandidates: LinkedInPerson[];
  /** The LinkedIn company URL used for the lookup. */
  linkedInCompanyUrl: string | null;
  /** Reason the enrichment was skipped (if skipped). */
  skippedReason?: string;
}

// Keep backward-compat export for any code that imports the old type
export interface LinkedInSearchResult {
  people: LinkedInPerson[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APIFY_ACTOR_ID = "Vb6LZkh4EqRlR0Ka9"; // harvestapi/linkedin-company-employees
const MAX_EMPLOYEES = parseInt(process.env.APIFY_MAX_EMPLOYEES ?? "10", 10);
const ACTOR_TIMEOUT_MS = 130_000; // 120s actor + 10s network margin

// ---------------------------------------------------------------------------
// Title variant expansion
// Expands a target title into all common LinkedIn variants to maximise recall.
// ---------------------------------------------------------------------------

const TITLE_VARIANT_MAP: Record<string, string[]> = {
  "ceo": ["CEO", "Chief Executive Officer", "Founder", "Co-Founder", "Owner", "Managing Director", "President"],
  "founder": ["Founder", "Co-Founder", "CEO", "Owner", "Managing Director"],
  "cto": ["CTO", "Chief Technology Officer", "VP Engineering", "VP Technology", "Head of Technology", "Technical Director"],
  "coo": ["COO", "Chief Operating Officer", "VP Operations", "Director of Operations", "General Manager"],
  "cfo": ["CFO", "Chief Financial Officer", "VP Finance", "Finance Director"],
  "cmo": ["CMO", "Chief Marketing Officer", "VP Marketing", "Marketing Director", "Head of Marketing"],
  "partner": ["Partner", "Managing Partner", "General Partner", "Founding Partner", "GP", "Principal"],
  "director": ["Director", "Managing Director", "Executive Director", "Director of Operations", "Director of Marketing"],
  "vp": ["VP", "Vice President", "SVP", "EVP", "Senior Vice President", "Executive Vice President"],
  "manager": ["Manager", "Senior Manager", "Account Manager", "Project Manager", "General Manager"],
  "associate": ["Associate", "Senior Associate", "Investment Associate", "Business Development Associate"],
};

function expandTitleVariants(targetTitles: string[]): string[] {
  const variants = new Set<string>();
  for (const t of targetTitles) {
    variants.add(t);
    const key = t.toLowerCase().replace(/[^a-z]/g, "");
    for (const [mapKey, mapVariants] of Object.entries(TITLE_VARIANT_MAP)) {
      if (key.includes(mapKey) || mapKey.includes(key)) {
        for (const v of mapVariants) variants.add(v);
      }
    }
  }
  return Array.from(variants).slice(0, 15); // LinkedIn title filter supports up to 15
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getApiKey(): string {
  return process.env.APIFY_API_KEY ?? "";
}

/**
 * Locates the LinkedIn company page URL for a given company name + domain.
 * Tries two search queries; returns null if neither finds a /company/ URL.
 * This is a SERP search — no Apify cost.
 */
async function findLinkedInCompanyUrl(
  companyName: string,
  domain: string,
): Promise<string | null> {
  const extractCompanyUrl = (url: string): string | null => {
    const m = url.match(/linkedin\.com\/company\/([^/?#\s]+)/);
    return m ? `https://www.linkedin.com/company/${m[1]}/` : null;
  };

  // 1. Search by exact company name
  try {
    const results = await webSearch(`"${companyName}" site:linkedin.com/company`, 5);
    for (const r of results) {
      const found = extractCompanyUrl(r.url ?? "");
      if (found) return found;
    }
  } catch (err) {
    console.warn(`[apifyLinkedIn] SERP search failed for "${companyName}":`, err);
  }

  // 2. Fallback: search by domain
  try {
    const cleanDomain = domain.replace(/^www\./, "");
    const results = await webSearch(`site:linkedin.com/company ${cleanDomain}`, 3);
    for (const r of results) {
      const found = extractCompanyUrl(r.url ?? "");
      if (found) return found;
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Maps a raw Apify actor output item to a LinkedInPerson.
 * Handles multiple field-name conventions used across actor versions.
 */
function parseEmployee(item: Record<string, unknown>): LinkedInPerson | null {
  const rawName =
    (item.name as string | undefined) ??
    (item.fullName as string | undefined) ??
    `${item.firstName ?? ""} ${item.lastName ?? ""}`.trim();

  // "headline" is often "Owner at Acme Corp" — keep only the part before " at "
  const rawTitle =
    (item.position as string | undefined) ??
    (item.title as string | undefined) ??
    (item.jobTitle as string | undefined) ??
    (item.headline as string | undefined)?.split(/ at /i)[0] ??
    "";

  const rawLinkedIn =
    (item.profileUrl as string | undefined) ??
    (item.linkedinUrl as string | undefined) ??
    (item.linkedinProfileUrl as string | undefined) ??
    (item.url as string | undefined) ??
    "";

  if (!rawName || !rawTitle) return null;

  const nameParts = rawName.trim().split(/\s+/);
  const firstName = nameParts[0] ?? "";
  const lastName = nameParts.slice(1).join(" ");

  return {
    firstName,
    lastName,
    name: rawName.trim(),
    title: rawTitle.trim(),
    linkedinUrl: rawLinkedIn,
    seniority: (item.seniority as string | undefined) ?? "",
  };
}

/**
 * Confidence gate: should we call Apify at all?
 *
 * Returns true (skip) when the website scrape already filled all DM fields
 * at high confidence — no point paying for LinkedIn data we already have.
 */
function shouldSkipLinkedInEnrichment(
  sections: AgentSection[],
  fieldResults: FieldResultMap,
): { skip: boolean; reason: string } {
  // Find all decision-maker related sections
  const dmSections = sections.filter(s =>
    /decision.?maker|dm\d|contact|person|name|title|email/i.test(s.key + " " + s.label)
  );

  if (dmSections.length === 0) {
    return { skip: true, reason: "No decision maker sections defined" };
  }

  // Check if all DM fields are already high-confidence
  const allHighConfidence = dmSections.every(s =>
    (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD
  );

  if (allHighConfidence) {
    return { skip: true, reason: "All DM fields already extracted at high confidence from website" };
  }

  return { skip: false, reason: "" };
}

/**
 * LLM re-ranking: given a pool of LinkedIn candidates, pick the best match
 * for the target roles defined in the sections.
 *
 * This is a tiny, cheap LLM call (~200 tokens) that ensures we pick the
 * right person from LinkedIn's opaque ranking, not just the first result.
 */
async function rerankCandidates(
  candidates: LinkedInPerson[],
  sections: AgentSection[],
  companyName: string,
): Promise<LinkedInPerson[]> {
  if (candidates.length <= 1) return candidates;

  const dmSections = sections.filter(s =>
    /decision.?maker|dm\d|contact|person|name|title/i.test(s.key + " " + s.label)
  );
  const targetRoleHint = dmSections.map(s => s.desc ?? s.label).join("; ");

  const candidateList = candidates
    .map((c, i) => `${i + 1}. ${c.name} — ${c.title}`)
    .join("\n");

  const prompt = `You are selecting the best decision maker contact for outreach at "${companyName}".

Target role criteria: ${targetRoleHint || "Senior decision maker (CEO, Founder, Director, VP, Partner)"}

Candidates from LinkedIn:
${candidateList}

Rank these candidates from most to least relevant for outreach. Return ONLY a JSON array of indices (1-based) in order of relevance, e.g. [2, 1, 3].`;

  try {
    const resp = await queuedLLMCall({
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
    });
    const rawContent = resp.choices[0]?.message?.content;
    const raw = (typeof rawContent === 'string' ? rawContent : "").trim();
    const match = raw.match(/\[[\d,\s]+\]/);
    if (match) {
      const order = JSON.parse(match[0]) as number[];
      const reranked = order
        .map(i => candidates[i - 1])
        .filter((c): c is LinkedInPerson => !!c);
      return reranked.map((c, i) => ({
        ...c,
        relevanceScore: Math.max(0, 1 - i * 0.15),
      }));
    }
  } catch (err) {
    console.warn("[apifyLinkedIn] Re-ranking LLM call failed:", err);
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Enriches decision maker data using LinkedIn via Apify.
 *
 * Smart flow:
 *   1. Confidence gate — skip if website already gave us everything
 *   2. Use known LinkedIn URL if provided (from preLLMExtractor — free)
 *   3. Otherwise, find LinkedIn URL via SERP search (no Apify cost)
 *   4. Call Apify actor with title filter + maxItems cap
 *   5. LLM re-rank candidates to pick the best match
 */
export async function enrichWithLinkedIn(
  domain: string,
  companyName: string,
  sections: AgentSection[],
  fieldResults: FieldResultMap,
  knownLinkedInUrl?: string | null,
  targetTitles?: string[],
): Promise<LinkedInEnrichmentResult> {
  const apiKey = getApiKey();

  if (!apiKey) {
    return {
      bestMatch: null,
      allCandidates: [],
      linkedInCompanyUrl: null,
      skippedReason: "APIFY_API_KEY not set",
    };
  }

  // Step 1: Confidence gate
  const { skip, reason } = shouldSkipLinkedInEnrichment(sections, fieldResults);
  if (skip) {
    console.log(`[apifyLinkedIn] Skipping for "${companyName}": ${reason}`);
    return {
      bestMatch: null,
      allCandidates: [],
      linkedInCompanyUrl: knownLinkedInUrl ?? null,
      skippedReason: reason,
    };
  }

  // Step 2: Resolve LinkedIn company URL
  let linkedInUrl: string | null = knownLinkedInUrl ?? null;
  if (!linkedInUrl) {
    console.log(`[apifyLinkedIn] No LinkedIn URL on website for "${companyName}" — searching via SERP`);
    linkedInUrl = await findLinkedInCompanyUrl(companyName || domain, domain);
  } else {
    console.log(`[apifyLinkedIn] Using LinkedIn URL from website for "${companyName}": ${linkedInUrl}`);
  }

  if (!linkedInUrl) {
    return {
      bestMatch: null,
      allCandidates: [],
      linkedInCompanyUrl: null,
      skippedReason: "LinkedIn company URL not found",
    };
  }

  // Step 3: Build title filter with variant expansion
  const titlesToFilter = expandTitleVariants(
    targetTitles && targetTitles.length > 0
      ? targetTitles
      : ["CEO", "Founder", "Director", "VP", "Partner", "Managing Director"]
  );

  console.log(`[apifyLinkedIn] Calling actor for "${companyName}" — ${titlesToFilter.length} title variants, maxItems=${MAX_EMPLOYEES}`);

  // Step 4: Call Apify actor
  let allCandidates: LinkedInPerson[] = [];
  try {
    const endpoint =
      `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/run-sync-get-dataset-items` +
      `?token=${apiKey}&timeout=120&memory=256`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companies: [linkedInUrl],
        currentJobTitles: titlesToFilter,
        maxItems: MAX_EMPLOYEES,
        profileScraperMode: process.env.APIFY_SCRAPER_MODE ?? "Full ($8 per 1k)",
      }),
      signal: AbortSignal.timeout(ACTOR_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(`[apifyLinkedIn] HTTP ${response.status} for "${companyName}": ${body.slice(0, 300)}`);
      return {
        bestMatch: null,
        allCandidates: [],
        linkedInCompanyUrl: linkedInUrl,
        skippedReason: `Apify HTTP ${response.status}`,
      };
    }

    const items = (await response.json()) as Record<string, unknown>[];
    console.log(`[apifyLinkedIn] Actor returned ${items.length} items for "${companyName}"`);

    allCandidates = items
      .map(parseEmployee)
      .filter((p): p is LinkedInPerson => p !== null);

    console.log(`[apifyLinkedIn] Parsed ${allCandidates.length} valid contacts for "${companyName}"`);
  } catch (err) {
    console.warn(`[apifyLinkedIn] Request failed for "${companyName}":`, err);
    return {
      bestMatch: null,
      allCandidates: [],
      linkedInCompanyUrl: linkedInUrl,
      skippedReason: "Apify request failed",
    };
  }

  if (allCandidates.length === 0) {
    return {
      bestMatch: null,
      allCandidates: [],
      linkedInCompanyUrl: linkedInUrl,
      skippedReason: "No matching employees returned by Apify",
    };
  }

  // Step 5: LLM re-ranking
  const reranked = await rerankCandidates(allCandidates, sections, companyName);
  const bestMatch = reranked[0] ?? null;

  if (bestMatch) {
    console.log(`[apifyLinkedIn] Best match for "${companyName}": ${bestMatch.name} (${bestMatch.title})`);
  }

  return {
    bestMatch,
    allCandidates: reranked,
    linkedInCompanyUrl: linkedInUrl,
  };
}

// ---------------------------------------------------------------------------
// Backward-compat shim for any code that still calls apifySearchLinkedInEmployees
// ---------------------------------------------------------------------------
export async function apifySearchLinkedInEmployees(
  domain: string,
  companyName: string,
  maxResults = 25,
): Promise<LinkedInSearchResult> {
  const result = await enrichWithLinkedIn(domain, companyName, [], {});
  return { people: result.allCandidates };
}
