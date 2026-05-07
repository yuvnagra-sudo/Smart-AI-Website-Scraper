/**
 * Vayne.io API Client
 *
 * Scrapes LinkedIn company pages for employees — LIGHTWEIGHT mode that
 * returns name + title only, NOT full profile data.
 *
 * Vayne has two products:
 * - "Leads & Companies scraper" (lightweight, list mode) — ~$0.0025/lead
 * - "Profiles scraper" (heavy, full bio/about/experience) — same per-profile cost
 *
 * We only need name + title to feed the LLM re-eval, so we use list mode and
 * cap at 10 employees per company by default (configurable).
 *
 * Auth: Bearer token via VAYNE_API_KEY env var.
 */

const VAYNE_BASE_URL = "https://api.vayne.io/v1";

// Cap to control cost — can be raised via env var
const VAYNE_MAX_EMPLOYEES = parseInt(process.env.VAYNE_MAX_EMPLOYEES ?? "10", 10);

function getApiKey(): string {
  return process.env.VAYNE_API_KEY ?? "";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VaynePerson {
  fullName: string;
  firstName: string;
  lastName: string;
  title: string;
  linkedinUrl: string;
  location: string | null;
  headline: string | null;
}

export interface VayneCompanyResult {
  people: VaynePerson[];
  totalEmployees: number;
  companyName: string | null;
  skippedReason?: string;
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

export function isVayneAvailable(): boolean {
  return !!getApiKey();
}

// ---------------------------------------------------------------------------
// Submit a company-employees scrape job
// ---------------------------------------------------------------------------

/**
 * Scrape a LinkedIn company page for employees via Vayne.
 * Returns up to 25 employees with names, titles, and LinkedIn URLs.
 *
 * Returns empty result with skippedReason if:
 * - VAYNE_API_KEY not set
 * - LinkedIn URL not provided
 * - API call fails
 * - Vayne rate limited / out of credits
 */
export async function vayneScrapeCompanyEmployees(
  linkedinCompanyUrl: string,
): Promise<VayneCompanyResult> {
  if (!getApiKey()) {
    return { people: [], totalEmployees: 0, companyName: null, skippedReason: "VAYNE_API_KEY not set" };
  }
  if (!linkedinCompanyUrl || !linkedinCompanyUrl.includes("linkedin.com/company/")) {
    return { people: [], totalEmployees: 0, companyName: null, skippedReason: "Invalid LinkedIn company URL" };
  }

  console.log(`[vayneApi] Scraping employees for: ${linkedinCompanyUrl}`);

  try {
    const { withJobSignal, getJobSignal } = await import("../_core/jobContext");
    // Vayne uses an order-based async API. Submit the order first, then poll for results.
    // Use "list" mode — returns name + title only, NOT full profile scrapes.
    // This is the cheap "Leads & Companies scraper" path, not "Profiles scraper".
    const submitRes = await fetch(`${VAYNE_BASE_URL}/orders`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "company_employees",
        input: {
          url: linkedinCompanyUrl,
          max_employees: VAYNE_MAX_EMPLOYEES,
          mode: "list",          // lightweight: name + title only, no profile scraping
          enrich_profiles: false, // do NOT scrape each individual's full profile
        },
      }),
      signal: withJobSignal(AbortSignal.timeout(15_000)),
    });

    if (submitRes.status === 401 || submitRes.status === 403) {
      return { people: [], totalEmployees: 0, companyName: null, skippedReason: `Auth error ${submitRes.status}` };
    }
    if (submitRes.status === 429) {
      return { people: [], totalEmployees: 0, companyName: null, skippedReason: "Rate limited" };
    }
    if (!submitRes.ok) {
      return { people: [], totalEmployees: 0, companyName: null, skippedReason: `HTTP ${submitRes.status}` };
    }

    const submitJson = (await submitRes.json()) as { id?: string; order_id?: string };
    const orderId = submitJson.id || submitJson.order_id;
    if (!orderId) {
      return { people: [], totalEmployees: 0, companyName: null, skippedReason: "No order ID returned" };
    }

    // Poll for completion (up to 60s). Bail immediately if the job is cancelled
    // so we don't keep paying for Vayne polls after the user clicks Cancel.
    let result: any = null;
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const sig = getJobSignal();
      if (sig?.aborted) {
        return { people: [], totalEmployees: 0, companyName: null, skippedReason: "Cancelled mid-poll" };
      }
      const pollRes = await fetch(`${VAYNE_BASE_URL}/orders/${orderId}`, {
        headers: { "Authorization": `Bearer ${getApiKey()}` },
        signal: withJobSignal(AbortSignal.timeout(10_000)),
      });
      if (!pollRes.ok) continue;
      result = await pollRes.json();
      if (result.status === "completed" || result.status === "done" || result.results) break;
      if (result.status === "failed" || result.status === "error") {
        return { people: [], totalEmployees: 0, companyName: null, skippedReason: `Order failed: ${result.error || "unknown"}` };
      }
    }

    if (!result || (result.status !== "completed" && result.status !== "done" && !result.results)) {
      return { people: [], totalEmployees: 0, companyName: null, skippedReason: "Order timed out" };
    }

    // Track cost — ~$0.0025 per profile on Starter plan
    try {
      const { addExternalCost } = await import("../_core/openaiLLM");
      const employeeCount = (result.results || result.employees || []).length;
      addExternalCost(0.0025 * employeeCount, `vayne.io company employees (${employeeCount})`);
    } catch { /* non-fatal */ }

    const rawPeople = result.results || result.employees || [];
    const people: VaynePerson[] = rawPeople.map((p: any) => ({
      fullName: p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim(),
      firstName: p.first_name || "",
      lastName: p.last_name || "",
      title: p.title || p.headline || "",
      linkedinUrl: p.linkedin_url || p.url || "",
      location: p.location || null,
      headline: p.headline || null,
    })).filter((p: VaynePerson) => p.fullName.length > 1);

    console.log(`[vayneApi] Found ${people.length} employees at ${linkedinCompanyUrl}`);
    if (people.length > 0) {
      console.log(`  Top: ${people[0].fullName} — ${people[0].title}`);
    }

    return {
      people,
      totalEmployees: people.length,
      companyName: result.company_name || null,
    };
  } catch (err) {
    console.warn(`[vayneApi] Company scrape failed for ${linkedinCompanyUrl}:`, err);
    return { people: [], totalEmployees: 0, companyName: null, skippedReason: String(err) };
  }
}
