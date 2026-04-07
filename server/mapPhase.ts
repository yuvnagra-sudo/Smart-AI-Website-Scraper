/**
 * Map Phase — Lightweight URL Discovery Before Deep Extraction
 *
 * Inspired by Firecrawl's architecture: before extracting data from pages,
 * first "map" the site to identify the most promising pages to visit.
 *
 * This replaces the ad-hoc "people boost" in scrapeUrl with a structured
 * discovery phase that uses heuristics first, then an optional cheap LLM call
 * (gpt-5-nano) to classify ambiguous links.
 *
 * Returns a prioritized list of URLs to visit, categorized by what type of
 * data they likely contain.
 */

import { queuedLLMCall } from "./_core/llmQueue";
import { getProfile } from "./agentConfig";
import type { AgentSection } from "./agentScraper";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MappedUrl {
  url: string;
  category: "team" | "about" | "contact" | "services" | "portfolio" | "other";
  priority: number; // 1 = highest priority
  reason: string;
}

// ---------------------------------------------------------------------------
// Heuristic URL classification
// ---------------------------------------------------------------------------

// URL patterns built from agent profile config
function buildUrlPatterns(): Array<{ category: MappedUrl["category"]; patterns: RegExp[]; priority: number }> {
  const profileCats = getProfile().urlCategories;
  return Object.entries(profileCats).map(([category, config]) => ({
    category: category as MappedUrl["category"],
    patterns: config.patterns.map((p: string) => new RegExp(p, "i")),
    priority: config.priority,
  }));
}

const URL_PATTERNS = buildUrlPatterns();

function classifyUrl(url: string): { category: MappedUrl["category"]; priority: number } | null {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    for (const { category, patterns, priority } of URL_PATTERNS) {
      if (patterns.some(p => p.test(pathname))) {
        return { category, priority };
      }
    }
  } catch { /* invalid URL */ }
  return null;
}

// ---------------------------------------------------------------------------
// Map Phase: heuristic pass
// ---------------------------------------------------------------------------

/**
 * Heuristic URL mapper — fast, no LLM needed.
 * Scans a list of extracted links and classifies them by likely content type.
 * Returns prioritized URLs for the agent to visit.
 */
export function mapUrlsHeuristic(
  links: string[],
  baseUrl: string,
  sections: AgentSection[],
): MappedUrl[] {
  const mapped: MappedUrl[] = [];
  const seen = new Set<string>();
  let baseDomain = "";
  try { baseDomain = new URL(baseUrl).hostname.replace(/^www\./, ""); } catch { /* ignore */ }

  // Determine what types of pages we need based on sections
  const needsPeople = sections.some(s =>
    /decision.maker|contact|ceo|founder|owner|director|manager|team|people|staff|leadership/i.test(s.key + " " + s.label)
  );
  const needsServices = sections.some(s =>
    /service|focus|specialt|expertise|capability|practice/i.test(s.key + " " + s.label)
  );

  for (const link of links) {
    if (seen.has(link)) continue;
    seen.add(link);

    // Accept same-domain links including www. prefix and subdomains (team.acme.com, about.acme.com)
    try {
      const linkHost = new URL(link).hostname.replace(/^www\./, "");
      if (linkHost !== baseDomain && !linkHost.endsWith("." + baseDomain)) continue;
    } catch { continue; }

    const classification = classifyUrl(link);
    if (classification) {
      mapped.push({
        url: link,
        category: classification.category,
        priority: classification.priority,
        reason: `URL path matches ${classification.category} pattern`,
      });
    }
  }

  // Sort by priority, then deduplicate categories (keep best per category)
  mapped.sort((a, b) => a.priority - b.priority);

  // Boost priorities based on what sections need
  if (needsPeople) {
    for (const m of mapped) {
      if (m.category === "team") m.priority = 0; // Top priority
      if (m.category === "about") m.priority = Math.min(m.priority, 1);
      // Contact pages often have owner/manager name + email for small businesses
      if (m.category === "contact") m.priority = Math.min(m.priority, 1);
    }
  }
  if (needsServices) {
    for (const m of mapped) {
      if (m.category === "services") m.priority = Math.min(m.priority, 1);
    }
  }

  // Re-sort after boosting
  mapped.sort((a, b) => a.priority - b.priority);

  return mapped;
}

// ---------------------------------------------------------------------------
// Map Phase: LLM-assisted (for ambiguous navigation)
// ---------------------------------------------------------------------------

/**
 * LLM-assisted URL mapper — uses gpt-5-nano to classify ambiguous links.
 * Only called when heuristic mapping finds fewer relevant URLs than needed.
 * This is cheap (~$0.001 per call) and fast.
 */
export async function mapUrlsWithLLM(
  links: string[],
  baseUrl: string,
  sections: AgentSection[],
  companyName: string,
): Promise<MappedUrl[]> {
  // First run heuristic mapping
  const heuristicResults = mapUrlsHeuristic(links, baseUrl, sections);

  // Determine what types of pages we need
  const needsPeople = sections.some(s =>
    /decision.maker|contact|ceo|founder|owner|director|manager|team|people|staff|leadership/i.test(s.key + " " + s.label)
  );

  // If heuristics found team pages and we need people, we're good
  const hasTeamPage = heuristicResults.some(r => r.category === "team");
  if (hasTeamPage || !needsPeople) {
    return heuristicResults;
  }

  // Filter to same-domain links not already classified
  const classifiedUrls = new Set(heuristicResults.map(r => r.url));
  let baseDomain = "";
  try { baseDomain = new URL(baseUrl).hostname.replace(/^www\./, ""); } catch { /* ignore */ }

  const unclassified = links.filter(l => {
    if (classifiedUrls.has(l)) return false;
    try {
      const lHost = new URL(l).hostname.replace(/^www\./, "");
      return lHost === baseDomain || lHost.endsWith("." + baseDomain);
    } catch { return false; }
  }).slice(0, 25); // Limit to 25 — cheap gpt-5-nano call; 15 was too few for SPA sites with 50+ routes

  if (unclassified.length === 0) return heuristicResults;

  // Use cheap model to classify remaining links
  const sectionList = sections.map(s => `${s.label}: ${s.desc}`).join("\n");

  try {
    const response = await queuedLLMCall({
      model: "gpt-5-nano",
      messages: [{
        role: "user",
        content: `You are analyzing the navigation of ${companyName}'s website (${baseUrl}).

I need to find pages containing: team members, leadership, about, contact information.

Here are unclassified links from the site. For each, classify it:

${unclassified.map((u, i) => `${i + 1}. ${u}`).join("\n")}

Fields I need to fill:
${sectionList}

Return ONLY the URLs most likely to contain team/people/leadership information.`,
      }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "mapped_urls",
          strict: true,
          schema: {
            type: "object",
            properties: {
              urls: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    url: { type: "string" },
                    category: { type: "string", enum: ["team", "about", "contact", "services", "other"] },
                    reason: { type: "string" },
                  },
                  required: ["url", "category", "reason"],
                  additionalProperties: false,
                },
              },
            },
            required: ["urls"],
            additionalProperties: false,
          },
        },
      },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");
    const llmMapped = (parsed.urls ?? []) as Array<{ url: string; category: string; reason: string }>;

    // Merge LLM results with heuristic results
    for (const item of llmMapped) {
      if (!classifiedUrls.has(item.url)) {
        const cat = item.category as MappedUrl["category"];
        const priority = cat === "team" ? 1 : cat === "about" ? 2 : cat === "contact" ? 3 : 5;
        heuristicResults.push({
          url: item.url,
          category: cat,
          priority,
          reason: `LLM: ${item.reason}`,
        });
        classifiedUrls.add(item.url);
      }
    }

    console.log(`[mapPhase] LLM classified ${llmMapped.length} additional URLs for ${companyName}`);
  } catch (err) {
    console.warn(`[mapPhase] LLM mapping failed (non-fatal):`, err instanceof Error ? err.message : String(err).slice(0, 100));
  }

  // Re-sort
  heuristicResults.sort((a, b) => a.priority - b.priority);
  return heuristicResults;
}

/**
 * Generate candidate team page URLs from a base URL.
 * These are common paths where team/leadership pages are found.
 */
export function generateTeamPageCandidates(baseUrl: string): string[] {
  try {
    const origin = new URL(baseUrl).origin;
    const candidates = getProfile().teamPageCandidates;
    return candidates.map(p => `${origin}${p}`);
  } catch {
    return [];
  }
}
