/**
 * Serper.dev Search API Client
 *
 * Uses the same SERPER_API_KEY as the gtm-offer-engine repo.
 * Provides Google SERP results without getting blocked (unlike raw scraping).
 *
 * Primary use: resolve partial names from Apollo (first name + obfuscated last)
 * into full LinkedIn profiles via targeted Google search.
 *
 * Cost: ~$0.001 per search (1 credit). 2,500 free credits on signup.
 */

const SERPER_API_URL = "https://google.serper.dev";

function getApiKey(): string {
  return process.env.SERPER_API_KEY ?? "";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SerperSearchResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
}

export interface LinkedInSearchResult {
  fullName: string | null;
  linkedinUrl: string | null;
  title: string | null;
  confidence: "High" | "Medium" | "Low";
  skippedReason?: string;
}

// ---------------------------------------------------------------------------
// Core search
// ---------------------------------------------------------------------------

async function serperSearch(query: string, num: number = 5): Promise<SerperSearchResult[]> {
  const apiKey = getApiKey();
  if (!apiKey) return [];

  try {
    const res = await fetch(`${SERPER_API_URL}/search`, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, num }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(`[serperSearch] HTTP ${res.status} for query: ${query}`);
      return [];
    }

    const json = (await res.json()) as {
      organic?: Array<{ title?: string; link?: string; snippet?: string; position?: number }>;
    };

    // Track Serper cost: ~$0.001 per search (1 credit)
    try {
      const { addExternalCost } = await import("../_core/openaiLLM");
      addExternalCost(0.001, "serper.dev search");
    } catch { /* non-fatal */ }

    return (json.organic ?? []).map((r, i) => ({
      title: r.title ?? "",
      link: r.link ?? "",
      snippet: r.snippet ?? "",
      position: r.position ?? i + 1,
    }));
  } catch (err) {
    console.warn(`[serperSearch] Failed:`, err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// LinkedIn name resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a partial name (first name + obfuscated last) into a full LinkedIn profile.
 * Uses Serper to Google search: `"Jane" "CTO" site:linkedin.com/in "companyname"`
 *
 * When Apollo returns has_email=true but last_name_obfuscated="S***h",
 * this function finds the full name + LinkedIn URL via SERP.
 */
export async function resolveLinkedInViaSERP(
  firstName: string,
  title: string,
  companyName: string,
  domain?: string,
): Promise<LinkedInSearchResult> {
  if (!getApiKey()) {
    return { fullName: null, linkedinUrl: null, title: null, confidence: "Low", skippedReason: "SERPER_API_KEY not set" };
  }
  if (!firstName || !companyName) {
    return { fullName: null, linkedinUrl: null, title: null, confidence: "Low", skippedReason: "Missing name or company" };
  }

  // Build a targeted search query
  // Example: "Jane" "CTO" site:linkedin.com/in "acmecorp"
  const companyTerm = domain
    ? `"${domain.replace(/\.(com|io|co|org|net)$/, '')}"`
    : `"${companyName}"`;
  const titleTerm = title ? `"${title}"` : "";
  const query = `"${firstName}" ${titleTerm} site:linkedin.com/in/ ${companyTerm}`.replace(/\s+/g, " ").trim();

  console.log(`[serperSearch] LinkedIn resolve: ${query}`);
  const results = await serperSearch(query, 3);

  // Filter to actual LinkedIn profile URLs
  const linkedinResults = results.filter(r =>
    r.link.includes("linkedin.com/in/") &&
    !r.link.includes("/posts/") &&
    !r.link.includes("/pulse/")
  );

  if (linkedinResults.length === 0) {
    console.log(`[serperSearch] No LinkedIn results for ${firstName} at ${companyName}`);
    return { fullName: null, linkedinUrl: null, title: null, confidence: "Low" };
  }

  const top = linkedinResults[0];

  // Extract full name from the LinkedIn title (usually "Jane Smith - CTO - Company | LinkedIn")
  const nameMatch = top.title.match(/^([A-Za-z\u00C0-\u024F\s.'-]+?)(?:\s*[-–—|])/);
  const fullName = nameMatch ? nameMatch[1].trim() : null;

  // Extract title from snippet or title
  const snippetTitle = top.snippet.match(/(?:^|\s)([A-Z][a-z]+(?:\s+[A-Za-z]+)*(?:\s+(?:at|@)\s+))/)?.[1]?.replace(/\s+(?:at|@)\s*$/, "").trim() || null;

  // Validate the result mentions the first name
  const resultLower = `${top.title} ${top.snippet}`.toLowerCase();
  const firstNameLower = firstName.toLowerCase();

  if (!resultLower.includes(firstNameLower)) {
    console.log(`[serperSearch] Top result doesn't match first name "${firstName}": ${top.title}`);
    return { fullName: null, linkedinUrl: null, title: null, confidence: "Low" };
  }

  const confidence = fullName && fullName.toLowerCase().startsWith(firstNameLower) ? "High" : "Medium";

  console.log(`[serperSearch] Resolved: ${firstName} → ${fullName || "?"} (${top.link}) [${confidence}]`);

  return {
    fullName,
    linkedinUrl: top.link,
    title: snippetTitle || title,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

export function isSerperAvailable(): boolean {
  return !!getApiKey();
}
