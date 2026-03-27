/**
 * Apify LinkedIn Company Employees — harvestapi/linkedin-company-employees
 *
 * Two-step flow:
 *   1. Find the LinkedIn company page URL via SERP (company name/domain → linkedin.com/company/X)
 *   2. Run the Apify actor with that URL to get the employee list
 *
 * Returns full, unobfuscated names + LinkedIn profile URLs — a significant
 * improvement over Apollo's free tier which only returns obfuscated initials.
 *
 * Gate: APIFY_API_KEY env var — returns [] when absent.
 */

import { webSearch } from "../_core/webSearch";

export interface LinkedInPerson {
  firstName: string;
  lastName: string;
  name: string;
  title: string;
  linkedinUrl: string;
  seniority: string;
}

export interface LinkedInSearchResult {
  people: LinkedInPerson[];
}

function getApiKey(): string {
  return process.env.APIFY_API_KEY ?? "";
}

/**
 * Locates the LinkedIn company page URL for a given company name + domain.
 * Tries two search queries; returns null if neither finds a /company/ URL.
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
    seniority: "",
  };
}

/**
 * Fetches LinkedIn company employees via Apify.
 *
 * @param domain       Company domain e.g. "topspeedmarketing.com"
 * @param companyName  Human-readable name used for LinkedIn URL lookup
 * @param maxResults   Max employees to return (capped at 100 by actor)
 */
export async function apifySearchLinkedInEmployees(
  domain: string,
  companyName: string,
  maxResults = 25,
): Promise<LinkedInSearchResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log("[apifyLinkedIn] APIFY_API_KEY not set — skipping LinkedIn lookup");
    return { people: [] };
  }

  if (!companyName && !domain) return { people: [] };

  // Step 1: find LinkedIn company URL
  const linkedInUrl = await findLinkedInCompanyUrl(companyName || domain, domain);
  if (!linkedInUrl) {
    console.log(`[apifyLinkedIn] Could not find LinkedIn URL for "${companyName}" (${domain})`);
    return { people: [] };
  }
  console.log(`[apifyLinkedIn] LinkedIn company URL for "${companyName}": ${linkedInUrl}`);

  // Step 2: run Apify actor synchronously
  try {
    const actorId = "Vb6LZkh4EqRlR0Ka9";
    const endpoint =
      `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items` +
      `?token=${apiKey}&timeout=120&memory=256`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companies: [linkedInUrl],
        profileScraperMode: process.env.APIFY_SCRAPER_MODE ?? "Full ($8 per 1k)",
      }),
      signal: AbortSignal.timeout(130_000), // 130s: 120s actor + network margin
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(
        `[apifyLinkedIn] HTTP ${response.status} for "${companyName}": ${body.slice(0, 300)}`,
      );
      return { people: [] };
    }

    const items = (await response.json()) as Record<string, unknown>[];
    console.log(`[apifyLinkedIn] Actor returned ${items.length} items for "${companyName}"`);

    const people = items
      .map(parseEmployee)
      .filter((p): p is LinkedInPerson => p !== null);

    console.log(`[apifyLinkedIn] Parsed ${people.length} valid contacts for "${companyName}"`);
    return { people };
  } catch (err) {
    console.warn(`[apifyLinkedIn] Request failed for "${companyName}":`, err);
    return { people: [] };
  }
}
