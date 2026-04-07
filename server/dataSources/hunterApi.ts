/**
 * Hunter.io API Integration — Domain Search
 *
 * Finds all known emails for a domain, each with first name, last name,
 * position, and seniority.  Used as the first-pass decision-maker finder
 * (cheaper than Apify LinkedIn, returns both name + email in one call).
 *
 * Cascade position:
 *   Website scrape → Hunter Domain Search → Apify LinkedIn → SMTP fallback
 *
 * Smart gating:
 *   - Skip if ALL DM name/title/email fields are already high-confidence
 *   - Skip if HUNTER_API_KEY is not set
 *
 * Pricing (Growth plan, $104/mo):
 *   - 10,000 credits/month  →  $0.0104 per credit
 *   - Domain Search: 1 credit per call (regardless of results returned)
 *
 * Docs: https://hunter.io/api-documentation/v2
 *
 * Gate: HUNTER_API_KEY env var — returns null when absent (graceful no-op).
 */

import type { AgentSection, FieldResultMap } from "../agentScraper";
import { CONFIDENCE_THRESHOLD } from "../agentScraper";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HunterEmail {
  value: string;
  type: "personal" | "generic" | string;
  confidence: number; // 0–100 (Hunter's own confidence score)
  firstName: string;
  lastName: string;
  position: string;
  seniority: "junior" | "senior" | "executive" | string | null;
  department: string | null;
  linkedinUrl: string | null;
  phoneNumber: string | null;
  sources: Array<{ domain: string; uri: string; extracted_on: string }>;
}

export interface HunterDomainSearchResult {
  /** Best-matched decision maker email entry (highest seniority + confidence). */
  bestMatch: HunterEmail | null;
  /** Full list of emails returned by Hunter. */
  allEmails: HunterEmail[];
  /** Total number of emails Hunter knows about for this domain (may exceed returned count). */
  totalEmails: number;
  /** Reason the call was skipped (if skipped). */
  skippedReason?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HUNTER_API_KEY = process.env.HUNTER_API_KEY ?? "";
const HUNTER_BASE_URL = "https://api.hunter.io/v2";

/**
 * Maximum emails to request from Domain Search.
 * Hunter returns up to 100 per call; we request all 100 at no extra cost
 * (1 credit per call regardless of result count).
 */
const MAX_EMAILS = parseInt(process.env.HUNTER_MAX_EMAILS ?? "100", 10);

/**
 * Seniority tiers for ranking (lower index = higher priority).
 * Hunter uses: "executive", "senior", "junior" (and null for unknown).
 */
const SENIORITY_RANK: Record<string, number> = {
  executive: 0,
  senior: 1,
  junior: 2,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getApiKey(): string {
  return HUNTER_API_KEY;
}

/**
 * Normalise a domain string: strip protocol, www, and trailing path.
 */
function cleanDomain(raw: string): string {
  return raw
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .toLowerCase()
    .trim();
}

/**
 * Map a raw Hunter API email object to our typed HunterEmail.
 */
function parseHunterEmail(raw: Record<string, unknown>): HunterEmail {
  return {
    value: (raw.value as string) ?? "",
    type: (raw.type as string) ?? "personal",
    confidence: (raw.confidence as number) ?? 0,
    firstName: (raw.first_name as string) ?? "",
    lastName: (raw.last_name as string) ?? "",
    position: (raw.position as string) ?? "",
    seniority: (raw.seniority as string | null) ?? null,
    department: (raw.department as string | null) ?? null,
    linkedinUrl: (raw.linkedin as string | null) ?? null,
    phoneNumber: (raw.phone_number as string | null) ?? null,
    sources: (raw.sources as HunterEmail["sources"]) ?? [],
  };
}

/**
 * Score an email entry for decision-maker relevance.
 * Higher = better candidate.
 *
 * Factors:
 *   - Seniority tier (executive > senior > junior > unknown)
 *   - Hunter confidence score (0–100)
 *   - Penalise generic addresses (info@, contact@, etc.)
 */
function scoreEmail(e: HunterEmail): number {
  const seniorityScore = 100 - (SENIORITY_RANK[e.seniority ?? ""] ?? 3) * 25;
  const isGeneric = e.type === "generic" ? -30 : 0;
  return seniorityScore + e.confidence + isGeneric;
}

// ---------------------------------------------------------------------------
// Gating logic
// ---------------------------------------------------------------------------

/**
 * Should we call Hunter Domain Search?
 *
 * Skip when:
 *   - No HUNTER_API_KEY set
 *   - All DM name + title + email fields are already high-confidence
 *     (website scrape gave us everything we need)
 */
export function shouldRunHunterDomainSearch(
  sections: AgentSection[],
  fieldResults: FieldResultMap,
): { run: boolean; reason: string } {
  if (!getApiKey()) {
    return { run: false, reason: "HUNTER_API_KEY not set" };
  }

  // Identify DM-related fields
  const dmSections = sections.filter(s =>
    /decision.?maker|dm\d|contact|person|name|title|email/i.test(s.key + " " + s.label),
  );

  if (dmSections.length === 0) {
    return { run: false, reason: "No decision maker sections defined" };
  }

  // If every DM field is already high-confidence, skip
  const allHighConfidence = dmSections.every(
    s => (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD,
  );

  if (allHighConfidence) {
    return {
      run: false,
      reason: "All DM fields already extracted at high confidence — skipping Hunter",
    };
  }

  return { run: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Domain Search
// ---------------------------------------------------------------------------

/**
 * Hunter Domain Search — find all known emails for a domain.
 *
 * Returns the best-matched decision maker plus the full list.
 * "Best match" is ranked by seniority → Hunter confidence → not generic.
 *
 * @param domain       - e.g. "acme.com" (bare domain, no protocol)
 * @param sections     - Agent sections (used for gating check)
 * @param fieldResults - Current field results (used for gating check)
 */
export async function hunterDomainSearch(
  domain: string,
  sections: AgentSection[],
  fieldResults: FieldResultMap,
): Promise<HunterDomainSearchResult> {
  const { run, reason } = shouldRunHunterDomainSearch(sections, fieldResults);
  if (!run) {
    return { bestMatch: null, allEmails: [], totalEmails: 0, skippedReason: reason };
  }

  const d = cleanDomain(domain);
  if (!d) {
    return { bestMatch: null, allEmails: [], totalEmails: 0, skippedReason: "Invalid domain" };
  }

  const url =
    `${HUNTER_BASE_URL}/domain-search` +
    `?domain=${encodeURIComponent(d)}` +
    `&limit=${MAX_EMAILS}` +
    `&api_key=${getApiKey()}`;

  try {
    console.log(`[hunterApi] Domain Search for: ${d}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

    if (res.status === 429) {
      console.warn(`[hunterApi] Rate limited (429) for ${d}`);
      return { bestMatch: null, allEmails: [], totalEmails: 0, skippedReason: "Rate limited" };
    }
    if (!res.ok) {
      console.warn(`[hunterApi] Domain Search HTTP ${res.status} for ${d}`);
      return { bestMatch: null, allEmails: [], totalEmails: 0, skippedReason: `HTTP ${res.status}` };
    }

    const json = (await res.json()) as {
      data?: {
        emails?: Record<string, unknown>[];
        meta?: { total?: number };
      };
      errors?: Array<{ id: string; details: string }>;
    };

    if (json.errors?.length) {
      const msg = json.errors[0].details;
      console.warn(`[hunterApi] Domain Search API error for ${d}: ${msg}`);
      return { bestMatch: null, allEmails: [], totalEmails: 0, skippedReason: msg };
    }

    const rawEmails = json.data?.emails ?? [];
    const totalEmails = json.data?.meta?.total ?? rawEmails.length;
    const allEmails = rawEmails.map(parseHunterEmail).filter(e => e.value);

    if (allEmails.length === 0) {
      console.log(`[hunterApi] No emails found for ${d}`);
      return { bestMatch: null, allEmails: [], totalEmails, skippedReason: "No emails found" };
    }

    // Rank by decision-maker relevance
    const ranked = [...allEmails].sort((a, b) => scoreEmail(b) - scoreEmail(a));
    const bestMatch = ranked[0];

    console.log(
      `[hunterApi] ✅ Domain Search for ${d}: ${allEmails.length} emails found, ` +
      `best: ${bestMatch.firstName} ${bestMatch.lastName} <${bestMatch.value}> (${bestMatch.position || bestMatch.seniority || "unknown role"})`,
    );

    return { bestMatch, allEmails, totalEmails };
  } catch (err) {
    console.warn(`[hunterApi] Domain Search failed for ${d}:`, err);
    return { bestMatch: null, allEmails: [], totalEmails: 0, skippedReason: String(err) };
  }
}
