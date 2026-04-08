/**
 * Hunter.io Domain Search API Client
 *
 * Uses Hunter's Domain Search endpoint to find email addresses associated
 * with a company domain. Returns the best decision-maker match ranked by
 * seniority and confidence score.
 *
 * Pricing: Growth plan $104/month = 10,000 credits/month.
 * Domain Search costs 1 credit per call regardless of email count returned.
 * Cost per call: ~$0.01
 *
 * Gating: Only fires when DM fields (name/email/title) are below confidence
 * threshold AND HUNTER_API_KEY is set.
 */

import type { AgentSection } from "../agentScraper";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HUNTER_BASE_URL = "https://api.hunter.io/v2";
const MAX_EMAILS = parseInt(process.env.HUNTER_MAX_EMAILS ?? "100", 10);
const CONFIDENCE_THRESHOLD = 0.65;

function getApiKey(): string {
  return process.env.HUNTER_API_KEY ?? "";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HunterEmail {
  value: string;
  type: "personal" | "generic" | string;
  confidence: number; // 0-100 (Hunter's scale)
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
  bestMatch: HunterEmail | null;
  allEmails: HunterEmail[];
  totalEmails: number;
  skippedReason?: string;
}

export interface FieldResult {
  value: string;
  confidence: number;
  sourceUrl?: string;
}

export type FieldResultMap = Record<string, FieldResult>;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Scoring — rank emails by decision-maker relevance
// ---------------------------------------------------------------------------

const SENIORITY_RANK: Record<string, number> = {
  executive: 0,
  senior: 1,
  junior: 2,
};

function scoreEmail(e: HunterEmail): number {
  const seniorityScore = 100 - (SENIORITY_RANK[e.seniority ?? ""] ?? 3) * 25;
  const isGeneric = e.type === "generic" ? -30 : 0;
  return seniorityScore + e.confidence + isGeneric;
}

// ---------------------------------------------------------------------------
// Gating — should we even call Hunter?
// ---------------------------------------------------------------------------

export function shouldRunHunterDomainSearch(
  sections: AgentSection[],
  fieldResults: FieldResultMap,
): { run: boolean; reason: string } {
  if (!getApiKey()) {
    return { run: false, reason: "HUNTER_API_KEY not set" };
  }

  const dmSections = sections.filter(s =>
    /decision.?maker|dm\d|contact|person|name|title|email/i.test(s.key + " " + s.label),
  );

  if (dmSections.length === 0) {
    return { run: false, reason: "No decision maker sections defined" };
  }

  // Skip if ALL DM fields already high-confidence
  const allHighConfidence = dmSections.every(
    s => (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD,
  );

  if (allHighConfidence) {
    return {
      run: false,
      reason: "All DM fields already extracted at high confidence",
    };
  }

  return { run: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Main API call
// ---------------------------------------------------------------------------

export async function hunterDomainSearch(
  domain: string,
  sections: AgentSection[],
  fieldResults: FieldResultMap,
): Promise<HunterDomainSearchResult> {
  // Gating check
  const gate = shouldRunHunterDomainSearch(sections, fieldResults);
  if (!gate.run) {
    return { bestMatch: null, allEmails: [], totalEmails: 0, skippedReason: gate.reason };
  }

  // Clean domain
  const d = domain.replace(/^www\./, "").toLowerCase();
  console.log(`[hunterApi] Domain Search: ${d}`);

  const url =
    `${HUNTER_BASE_URL}/domain-search` +
    `?domain=${encodeURIComponent(d)}` +
    `&limit=${MAX_EMAILS}` +
    `&api_key=${getApiKey()}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

    // Rate limiting
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

    // API errors
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
      return { bestMatch: null, allEmails: [], totalEmails };
    }

    // Rank by decision-maker relevance
    const sorted = [...allEmails].sort((a, b) => scoreEmail(b) - scoreEmail(a));
    const bestMatch = sorted[0];

    console.log(
      `[hunterApi] Found ${allEmails.length} emails for ${d}. ` +
      `Best: ${bestMatch.firstName} ${bestMatch.lastName} <${bestMatch.value}> ` +
      `(${bestMatch.position || bestMatch.seniority || "?"}, confidence: ${bestMatch.confidence})`,
    );

    return { bestMatch, allEmails, totalEmails };
  } catch (err) {
    console.warn(`[hunterApi] Domain Search failed for ${d}:`, err);
    return { bestMatch: null, allEmails: [], totalEmails: 0, skippedReason: String(err) };
  }
}
