/**
 * Apollo.io People Search API Client
 *
 * Uses Apollo's People Search endpoint to find people at a company domain.
 * Free tier: does not consume credits.
 * Rate limit: 50 calls/min, 600/day on free tier.
 *
 * IMPORTANT: The search endpoint returns LIMITED data (name, title, org name,
 * boolean flags like has_email). It does NOT return email, phone, linkedin_url,
 * city, state, country, or seniority. Those require the Enrichment endpoint
 * which costs credits.
 *
 * Runs in PARALLEL with Hunter.io in Phase 6.
 * Hunter provides emails; Apollo provides people discovery (including those
 * not listed on the company website).
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const APOLLO_BASE_URL = "https://api.apollo.io/api/v1";
const DEFAULT_PER_PAGE = 10;
const DEFAULT_SENIORITIES = ["owner", "founder", "c_suite", "partner", "vp", "director", "manager"];

function getApiKey(): string {
  return process.env.APOLLO_API_KEY ?? "";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApolloPerson {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  title: string;
  organizationName: string | null;
  hasEmail: boolean;
  hasPhone: boolean;
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
  // Search endpoint returns last_name OR last_name_obfuscated (partially hidden)
  const lastName = (raw.last_name as string) ?? (raw.last_name_obfuscated as string) ?? "";
  const org = raw.organization as Record<string, unknown> | undefined;

  return {
    id: (raw.id as string) ?? "",
    name: `${firstName} ${lastName}`.trim(),
    firstName,
    lastName,
    title: (raw.title as string) ?? "",
    organizationName: (org?.name as string | null) ?? null,
    hasEmail: (raw.has_email as boolean) ?? false,
    hasPhone: !!(raw.has_direct_phone && raw.has_direct_phone !== "No"),
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
    // Apollo docs show both X-Api-Key and Authorization: Bearer in different pages.
    // Send both headers to maximize compatibility.
    const apiKey = getApiKey();
    const res = await fetch(`${APOLLO_BASE_URL}/mixed_people/api_search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        "Authorization": `Bearer ${apiKey}`,
        "Cache-Control": "no-cache",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 429) {
      console.warn(`[apolloApi] Rate limited (429) for ${d}`);
      return { people: [], totalResults: 0, skippedReason: "Rate limited" };
    }

    if (res.status === 401 || res.status === 403) {
      console.warn(`[apolloApi] Auth error (${res.status}) for ${d}. Check APOLLO_API_KEY is a valid master key.`);
      return { people: [], totalResults: 0, skippedReason: `Auth error ${res.status}` };
    }

    if (!res.ok) {
      console.warn(`[apolloApi] HTTP ${res.status} for ${d}`);
      return { people: [], totalResults: 0, skippedReason: `HTTP ${res.status}` };
    }

    const json = (await res.json()) as {
      people?: Record<string, unknown>[];
      total_entries?: number;
      pagination?: { total_entries?: number };
    };

    const rawPeople = json.people ?? [];
    const totalResults = json.total_entries ?? json.pagination?.total_entries ?? rawPeople.length;
    const people = rawPeople
      .map(parseApolloPerson)
      .filter(p => p.name.trim().length > 1 && p.firstName.length > 0);

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
