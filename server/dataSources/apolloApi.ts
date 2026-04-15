/**
 * Apollo.io People Search API Client
 *
 * Uses Apollo's People Search endpoint to find people at a company domain.
 * Returns names, titles, seniority, LinkedIn URLs — but NOT emails/phones
 * (free tier limitation).
 *
 * Pricing: Free — People Search does not consume credits.
 * Rate limit: 50 calls/min, 600/day on free tier.
 *
 * Runs in PARALLEL with Hunter.io in Phase 6.
 * Hunter provides emails; Apollo provides people discovery (including those
 * not listed on the company website).
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const APOLLO_BASE_URL = "https://api.apollo.io/api/v1";
const DEFAULT_PER_PAGE = 25;
const DEFAULT_SENIORITIES = ["owner", "founder", "c_suite", "partner", "vp", "director", "manager"];

function getApiKey(): string {
  return process.env.APOLLO_API_KEY ?? "";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApolloPerson {
  name: string;
  title: string;
  seniority: string;
  headline: string;
  linkedinUrl: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  organizationName: string | null;
}

export interface ApolloSearchResult {
  people: ApolloPerson[];
  totalResults: number;
  skippedReason?: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseApolloPerson(raw: Record<string, unknown>): ApolloPerson {
  const firstName = (raw.first_name as string) ?? "";
  const lastName = (raw.last_name as string) ?? "";
  return {
    name: `${firstName} ${lastName}`.trim(),
    title: (raw.title as string) ?? "",
    seniority: (raw.seniority as string) ?? "",
    headline: (raw.headline as string) ?? "",
    linkedinUrl: (raw.linkedin_url as string | null) ?? null,
    city: (raw.city as string | null) ?? null,
    state: (raw.state as string | null) ?? null,
    country: (raw.country as string | null) ?? null,
    organizationName: ((raw.organization as Record<string, unknown>)?.name as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

export function shouldRunApolloSearch(): { run: boolean; reason: string } {
  if (!getApiKey()) {
    return { run: false, reason: "APOLLO_API_KEY not set" };
  }
  return { run: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Main API call
// ---------------------------------------------------------------------------

export async function apolloPeopleSearch(
  domain: string,
  targetTitles?: string[],
  seniorities?: string[],
): Promise<ApolloSearchResult> {
  const gate = shouldRunApolloSearch();
  if (!gate.run) {
    return { people: [], totalResults: 0, skippedReason: gate.reason };
  }

  const d = domain.replace(/^www\./, "").toLowerCase();
  console.log(`[apolloApi] People Search: ${d}`);

  const body: Record<string, unknown> = {
    q_organization_domains_list: [d],
    person_seniorities: seniorities ?? DEFAULT_SENIORITIES,
    per_page: DEFAULT_PER_PAGE,
    page: 1,
  };

  if (targetTitles && targetTitles.length > 0) {
    body.person_titles = targetTitles;
  }

  try {
    const res = await fetch(`${APOLLO_BASE_URL}/mixed_people/api_search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": getApiKey(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 429) {
      console.warn(`[apolloApi] Rate limited (429) for ${d}`);
      return { people: [], totalResults: 0, skippedReason: "Rate limited" };
    }

    if (res.status === 401 || res.status === 403) {
      console.warn(`[apolloApi] Auth error (${res.status}) for ${d}`);
      return { people: [], totalResults: 0, skippedReason: `Auth error ${res.status}` };
    }

    if (!res.ok) {
      console.warn(`[apolloApi] HTTP ${res.status} for ${d}`);
      return { people: [], totalResults: 0, skippedReason: `HTTP ${res.status}` };
    }

    const json = (await res.json()) as {
      people?: Record<string, unknown>[];
      pagination?: { total_entries?: number };
    };

    const rawPeople = json.people ?? [];
    const totalResults = json.pagination?.total_entries ?? rawPeople.length;
    const people = rawPeople
      .map(parseApolloPerson)
      .filter(p => p.name.trim().length > 0);

    console.log(
      `[apolloApi] Found ${people.length} people at ${d} (${totalResults} total). ` +
      (people.length > 0
        ? `Top: ${people[0].name} — ${people[0].title}`
        : "No results"),
    );

    return { people, totalResults };
  } catch (err) {
    console.warn(`[apolloApi] People Search failed for ${d}:`, err);
    return { people: [], totalResults: 0, skippedReason: String(err) };
  }
}
