/**
 * Dropcontact Email Enrichment
 *
 * Finds and verifies a professional email for a person given their full name
 * and company domain/website. Good EU coverage and built-in verification.
 *
 * Cost: ~€0.02–€0.04 per enriched contact.
 * Docs: https://developer.dropcontact.com/
 *
 * Gate: DROPCONTACT_API_KEY env var — returns null when absent.
 *
 * Note: Dropcontact enrichment is asynchronous — we poll until complete.
 */

export interface DropcontactResult {
  email: string;
  emailVerified: boolean;
}

const DROPCONTACT_API_KEY = process.env.DROPCONTACT_API_KEY ?? "";
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 15; // 30 seconds max wait

interface DropcontactContact {
  email?: string;
  email_valid?: boolean;
  email_qualification?: string;
}

/**
 * Find and verify a professional email via Dropcontact.
 *
 * @param firstName  - First name, e.g. "Jane"
 * @param lastName   - Last name, e.g. "Smith"
 * @param domain     - Company domain, e.g. "acme.com"
 * @returns DropcontactResult if email found and validated, null otherwise
 */
export async function dropcontactFindEmail(
  firstName: string,
  lastName: string,
  domain: string,
): Promise<DropcontactResult | null> {
  if (!DROPCONTACT_API_KEY) return null;

  const cleanDomain = domain
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase()
    .trim();

  try {
    // Submit enrichment request
    const submitRes = await fetch("https://api.dropcontact.com/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": DROPCONTACT_API_KEY,
      },
      body: JSON.stringify({
        data: [{ first_name: firstName, last_name: lastName, website: cleanDomain }],
        siren: false,
      }),
    });

    if (!submitRes.ok) {
      console.warn(`[dropcontactApi] Submit HTTP ${submitRes.status} for ${firstName} ${lastName} @ ${cleanDomain}`);
      return null;
    }

    const submitData = (await submitRes.json()) as { request_id?: string; error?: boolean };
    if (submitData.error || !submitData.request_id) return null;

    const requestId = submitData.request_id;

    // Poll for result
    for (let poll = 0; poll < MAX_POLLS; poll++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      const pollRes = await fetch(`https://api.dropcontact.com/batch/${requestId}`, {
        headers: { "X-Access-Token": DROPCONTACT_API_KEY },
      });

      if (!pollRes.ok) continue;

      const pollData = (await pollRes.json()) as {
        success?: boolean;
        data?: DropcontactContact[];
      };

      if (!pollData.success) continue; // Still processing

      const contact = pollData.data?.[0];
      if (!contact?.email) return null;

      // Accept if email_qualification is "nominative" or email_valid is true
      const isValid = contact.email_valid === true ||
        contact.email_qualification === "nominative";

      if (!isValid) return null;

      console.log(`[dropcontactApi] Found validated email for ${firstName} ${lastName}: ${contact.email}`);
      return { email: contact.email, emailVerified: true };
    }

    console.warn(`[dropcontactApi] Timed out polling for ${firstName} ${lastName}`);
    return null;
  } catch (err) {
    console.warn(`[dropcontactApi] Request failed for ${firstName} ${lastName}:`, err);
    return null;
  }
}
