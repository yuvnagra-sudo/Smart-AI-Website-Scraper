/**
 * Apollo.io People Search — FREE people discovery by domain
 *
 * Uses the "mixed_people/api_search" endpoint (replaced deprecated mixed_people/search
 * on Dec 15 2025) which returns first_name + last_name_obfuscated without consuming
 * email-reveal credits.
 *
 * Gate: APOLLO_API_KEY env var — returns [] when absent.
 *
 * Apollo seniority labels: "c_suite" | "vp" | "director" | "manager" |
 *   "individual_contributor" | "entry" | "intern" | "partner" | "owner"
 */

export interface ApolloPerson {
  firstName: string;
  lastName: string;
  name: string;
  title: string;
  linkedinUrl: string;
  seniority: string;
}

/** Company-level data extracted from Apollo's mixed_people response (free, no extra credits). */
export interface ApolloOrganization {
  employeeCount: number | null;
  /** e.g. "11-50", "51-200" */
  employeeRange: string | null;
  industry: string | null;
  foundedYear: number | null;
  city: string | null;
  country: string | null;
  shortDescription: string | null;
}

export interface ApolloSearchResult {
  people: ApolloPerson[];
  /** First organization found in the response, or null if none. */
  organization: ApolloOrganization | null;
}

// Read at call time so env vars set after module load are picked up (fix #4)
function getApiKey(): string {
  return process.env.APOLLO_API_KEY ?? "";
}

/**
 * Search for people at a company by domain.
 * Returns name/title plus any organization data embedded in the response.
 * No credits consumed — Apollo charges credits only when you request email
 * reveal, which we never do here.
 *
 * @param domain - Company domain, e.g. "acme.com"
 * @param seniorities - Apollo seniority labels to filter by
 * @param maxResults - Max contacts to return (capped at 100 by Apollo free tier)
 */
export async function apolloSearchPeople(
  domain: string,
  seniorities: string[] = ["c_suite", "vp", "director", "manager", "partner", "owner"],
  maxResults = 25,
): Promise<ApolloSearchResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log("[apolloApi] APOLLO_API_KEY not set — skipping Apollo lookup");
    return { people: [], organization: null };
  }

  // Strip protocol/path — Apollo needs bare domain
  const cleanDomain = domain
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase()
    .trim();

  if (!cleanDomain) return { people: [], organization: null };

  console.log(`[apolloApi] Searching people at domain: ${cleanDomain}`);

  try {
    const response = await fetch("https://api.apollo.io/api/v1/mixed_people/api_search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify({
        organization_domains: [cleanDomain],
        person_seniorities: seniorities,
        page: 1,
        per_page: Math.min(maxResults, 100),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.warn(
        `[apolloApi] HTTP ${response.status} for domain ${cleanDomain}: ${errorText.slice(0, 200)}`,
      );
      return { people: [], organization: null };
    }

    const data = (await response.json()) as {
      people?: Array<{
        first_name?: string;
        last_name_obfuscated?: string;
        title?: string;
        seniority?: string;
        organization_id?: string;
      }>;
      organizations?: Record<string, {
        estimated_num_employees?: number;
        employee_count_range?: string;
        industry?: string;
        founded_year?: number;
        city?: string;
        country?: string;
        short_description?: string;
      }>;
    };

    const people = data.people ?? [];
    console.log(`[apolloApi] Found ${people.length} people at ${cleanDomain}`);

    // Extract the first organization record embedded in the response (free, no extra credits)
    let organization: ApolloOrganization | null = null;
    const orgs = data.organizations ? Object.values(data.organizations) : [];
    if (orgs.length > 0) {
      const org = orgs[0];
      organization = {
        employeeCount: org.estimated_num_employees ?? null,
        employeeRange: org.employee_count_range ?? null,
        industry: org.industry ?? null,
        foundedYear: org.founded_year ?? null,
        city: org.city ?? null,
        country: org.country ?? null,
        shortDescription: org.short_description ?? null,
      };
      console.log(`[apolloApi] Org data for ${cleanDomain}: ${organization.employeeRange ?? organization.employeeCount ?? "no size"}, ${organization.industry ?? "no industry"}`);
    }

    return {
      people: people
        .filter((p) => p.first_name && p.title)
        .map((p) => ({
          firstName: p.first_name ?? "",
          lastName: p.last_name_obfuscated ?? "",
          name: `${p.first_name ?? ""} ${p.last_name_obfuscated ?? ""}`.trim(),
          title: p.title ?? "",
          linkedinUrl: "",
          seniority: p.seniority ?? "",
        })),
      organization,
    };
  } catch (err) {
    console.warn(`[apolloApi] Request failed for ${cleanDomain}:`, err);
    return { people: [], organization: null };
  }
}
