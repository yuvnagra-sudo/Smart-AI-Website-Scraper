/**
 * AnyMail Finder Email API
 *
 * Finds a professional email for a person given their full name and company domain.
 * Returns confidence level — we only accept "certain" results to avoid sending
 * to bad addresses.
 *
 * Cost: ~€0.065 per contact found (uncertain/not-found results are not charged).
 * Docs: https://anymailfinder.com/api/v4.0/
 *
 * Gate: ANYMAIL_FINDER_KEY env var — returns null when absent.
 */

export interface AnyMailFinderResult {
  email: string;
  confidence: "certain" | "probable" | "unknown";
}

const ANYMAIL_FINDER_KEY = process.env.ANYMAIL_FINDER_KEY ?? "";

/**
 * Find a professional email for a person.
 * Only returns results with "certain" confidence.
 *
 * @param firstName - First name, e.g. "Jane"
 * @param lastName  - Last name, e.g. "Smith"
 * @param domain    - Company domain, e.g. "acme.com"
 * @returns AnyMailFinderResult if found with "certain" confidence, null otherwise
 */
export async function anymailFinderFindEmail(
  firstName: string,
  lastName: string,
  domain: string,
): Promise<AnyMailFinderResult | null> {
  if (!ANYMAIL_FINDER_KEY) return null;

  const cleanDomain = domain
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase()
    .trim();

  try {
    const response = await fetch("https://api.anymailfinder.com/v4.0/search/person.json", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ANYMAIL_FINDER_KEY}`,
      },
      body: JSON.stringify({
        first_name: firstName,
        last_name: lastName,
        domain: cleanDomain,
      }),
    });

    if (!response.ok) {
      console.warn(`[anymailFinderApi] HTTP ${response.status} for ${firstName} ${lastName} @ ${cleanDomain}`);
      return null;
    }

    const data = (await response.json()) as {
      email?: string;
      result?: string;
    };

    if (!data.email || data.result !== "certain") return null;

    console.log(`[anymailFinderApi] Found certain email for ${firstName} ${lastName}: ${data.email}`);
    return { email: data.email, confidence: "certain" };
  } catch (err) {
    console.warn(`[anymailFinderApi] Request failed for ${firstName} ${lastName}:`, err);
    return null;
  }
}
