/**
 * Apollo.io People Search — FREE people discovery by domain
 *
 * Uses the "mixed_people/search" endpoint which returns name, title, and
 * LinkedIn URL without consuming any email-reveal credits.
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

const APOLLO_API_KEY = process.env.APOLLO_API_KEY ?? "";

/**
 * Search for people at a company by domain.
 * Returns name/title/LinkedIn URL. No credits consumed — Apollo charges
 * credits only when you request email reveal, which we never do here.
 *
 * @param domain - Company domain, e.g. "acme.com"
 * @param seniorities - Apollo seniority labels to filter by
 * @param maxResults - Max contacts to return (capped at 100 by Apollo free tier)
 */
export async function apolloSearchPeople(
  domain: string,
  seniorities: string[] = ["c_suite", "vp", "director", "manager", "partner", "owner"],
  maxResults = 25,
): Promise<ApolloPerson[]> {
  if (!APOLLO_API_KEY) {
    console.log("[apolloApi] APOLLO_API_KEY not set — skipping Apollo lookup");
    return [];
  }

  // Strip protocol/path — Apollo needs bare domain
  const cleanDomain = domain
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase()
    .trim();

  if (!cleanDomain) return [];

  console.log(`[apolloApi] Searching people at domain: ${cleanDomain}`);

  try {
    const response = await fetch("https://api.apollo.io/api/v1/mixed_people/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": APOLLO_API_KEY,
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
      return [];
    }

    const data = (await response.json()) as {
      people?: Array<{
        first_name?: string;
        last_name?: string;
        name?: string;
        title?: string;
        linkedin_url?: string;
        seniority?: string;
      }>;
    };

    const people = data.people ?? [];
    console.log(`[apolloApi] Found ${people.length} people at ${cleanDomain}`);

    return people
      .filter((p) => p.name && p.title) // Only contacts with name + title
      .map((p) => ({
        firstName: p.first_name ?? "",
        lastName: p.last_name ?? "",
        name: p.name ?? "",
        title: p.title ?? "",
        linkedinUrl: p.linkedin_url ?? "",
        seniority: p.seniority ?? "",
      }));
  } catch (err) {
    console.warn(`[apolloApi] Request failed for ${cleanDomain}:`, err);
    return [];
  }
}
