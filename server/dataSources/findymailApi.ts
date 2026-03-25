/**
 * Findymail Email Finder
 *
 * Finds a verified work email for a person given their full name and company domain.
 * Findymail performs SMTP verification inline — no separate verify step needed.
 *
 * Cost: ~$0.017–$0.049 per contact found (not-found results are not charged).
 * Docs: https://app.findymail.com/docs
 *
 * Gate: FINDYMAIL_API_KEY env var — returns null when absent.
 */

export interface FindymailResult {
  email: string;
  status: "valid" | "catch-all" | "invalid" | "unknown";
}

const FINDYMAIL_API_KEY = process.env.FINDYMAIL_API_KEY ?? "";

/**
 * Find a verified email for a person.
 *
 * @param fullName - Full name, e.g. "Jane Smith"
 * @param domain   - Company domain, e.g. "acme.com"
 * @returns FindymailResult if found, null otherwise
 */
export async function findymailFindEmail(
  fullName: string,
  domain: string,
): Promise<FindymailResult | null> {
  if (!FINDYMAIL_API_KEY) return null;

  const cleanDomain = domain
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase()
    .trim();

  try {
    const response = await fetch("https://app.findymail.com/api/search/name", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FINDYMAIL_API_KEY}`,
      },
      body: JSON.stringify({ name: fullName, domain: cleanDomain }),
    });

    if (!response.ok) {
      console.warn(`[findymailApi] HTTP ${response.status} for ${fullName} @ ${cleanDomain}`);
      return null;
    }

    const data = (await response.json()) as {
      email?: string;
      status?: string;
    };

    if (!data.email) return null;

    const status = data.status as FindymailResult["status"] ?? "unknown";
    console.log(`[findymailApi] Found ${status} email for ${fullName}: ${data.email}`);
    return { email: data.email, status };
  } catch (err) {
    console.warn(`[findymailApi] Request failed for ${fullName}:`, err);
    return null;
  }
}
