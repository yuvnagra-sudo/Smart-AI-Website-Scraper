/**
 * Agentic Scraper
 *
 * Orchestrates LLM-driven extraction for custom user-defined sections.
 * Supports two modes:
 *   - DIRECTORY: input URL is a listing page → collects entity URLs ("Collected URLs" tab)
 *   - PROFILE: input URL is an entity's own website → extracts user-defined fields + follows sub-links
 *
 * Builds on existing primitives: directoryExtractor, jinaFetcher, queuedLLMCall.
 */

import { fetchViaJina } from "./jinaFetcher";
import { extractDirectory, type DirectoryEntry as DirEntry } from "./directoryExtractor";
import { queuedLLMCall } from "./_core/llmQueue";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentSection {
  key: string;
  label: string;
  desc: string;
}

export interface DirectoryEntry {
  name: string;
  directoryUrl: string;
  nativeUrl?: string;
}

export type AgentScrapeResult =
  | { type: "directory"; entries: DirectoryEntry[] }
  | { type: "profile"; data: Record<string, string> };

type PageClass = "directory" | "directory-entry" | "profile";

interface PageClassification {
  type: PageClass;
  /** Inferred entity label for directory pages (e.g. "VC firms", "real-estate agents") */
  entityLabel: string;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// 1. Page classifier
// ---------------------------------------------------------------------------

async function classifyPage(
  content: string,
  url: string,
  objective: string,
): Promise<PageClassification> {
  const prompt = `You are analyzing a web page to classify its type.

URL: ${url}
User's objective: ${objective}

Page content (first 6000 chars):
${content.substring(0, 6000)}

Classify this page as ONE of:
- "directory": A listing/index page with many individual entries (companies, people, etc.) linked from it. Examples: VC firm databases, agent directories, company lists.
- "directory-entry": A page WITHIN a directory that is ABOUT a specific entity, but not the entity's own website. Contains info about the entity + usually a link to their native website.
- "profile": The actual website of a single entity (company, person, etc.). This is what we want to extract data from.

Also infer the entity label (e.g. "VC firms", "real-estate agents", "companies", "people") — used for directory extraction.

Return ONLY valid JSON:
{"type":"directory"|"directory-entry"|"profile","entityLabel":"string","reasoning":"one sentence"}`;

  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "page_classification",
          strict: true,
          schema: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["directory", "directory-entry", "profile"] },
              entityLabel: { type: "string" },
              reasoning: { type: "string" },
            },
            required: ["type", "entityLabel", "reasoning"],
            additionalProperties: false,
          },
        },
      },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");
    return {
      type: parsed.type ?? "profile",
      entityLabel: parsed.entityLabel ?? "entities",
      reasoning: parsed.reasoning ?? "",
    };
  } catch (err) {
    console.error("[agentScraper] classifyPage error:", err);
    // Default to profile to attempt extraction
    return { type: "profile", entityLabel: "entities", reasoning: "classification failed" };
  }
}

// ---------------------------------------------------------------------------
// 2. Directory-entry: extract native URL
// ---------------------------------------------------------------------------

async function extractNativeUrl(content: string, pageUrl: string): Promise<string | undefined> {
  const prompt = `This is a directory entry page about a specific company/organization.
Page URL: ${pageUrl}
Content (first 3000 chars):
${content.substring(0, 3000)}

Find the native website URL of the company/organization this page is about.
This is their own website (e.g. "https://acmecapital.com"), NOT a link to another directory page.
Look for links labelled "Website", "Visit website", "Homepage", or similar.

Return ONLY valid JSON: {"nativeUrl":"string or null"}`;

  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "native_url",
          strict: true,
          schema: {
            type: "object",
            properties: { nativeUrl: { type: ["string", "null"] } },
            required: ["nativeUrl"],
            additionalProperties: false,
          },
        },
      },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");
    return parsed.nativeUrl ?? undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 3. Profile field extraction
// ---------------------------------------------------------------------------

async function extractProfileFields(
  content: string,
  sections: AgentSection[],
  systemPrompt: string,
): Promise<Record<string, string>> {
  // Build per-section schema properties
  const props: Record<string, { type: string; description: string }> = {};
  for (const s of sections) {
    props[s.key] = { type: "string", description: `${s.label}: ${s.desc}` };
  }

  const userMsg = `${systemPrompt}

Page content:
${content.substring(0, 10000)}

Extract each field from the page content. If a field cannot be determined from the content, return an empty string "".
Return ONLY valid JSON with these keys: ${sections.map((s) => s.key).join(", ")}`;

  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: userMsg }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "field_extraction",
          strict: true,
          schema: {
            type: "object",
            properties: props,
            required: sections.map((s) => s.key),
            additionalProperties: false,
          },
        },
      },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");

    // Ensure all section keys are present
    const result: Record<string, string> = {};
    for (const s of sections) {
      result[s.key] = String(parsed[s.key] ?? "");
    }
    return result;
  } catch (err) {
    console.error("[agentScraper] extractProfileFields error:", err);
    const empty: Record<string, string> = {};
    for (const s of sections) empty[s.key] = "";
    return empty;
  }
}

// ---------------------------------------------------------------------------
// 4. Link decision — which sub-links to follow
// ---------------------------------------------------------------------------

interface LinkDecision {
  shouldStop: boolean;
  linksToFollow: string[];
}

async function decideNextLinks(
  partialData: Record<string, string>,
  sections: AgentSection[],
  pageContent: string,
  objective: string,
  visitedUrls: Set<string>,
): Promise<LinkDecision> {
  // Find fields that are still empty
  const missingFields = sections
    .filter((s) => !partialData[s.key]?.trim())
    .map((s) => s.label);

  if (missingFields.length === 0) {
    return { shouldStop: true, linksToFollow: [] };
  }

  // Extract all in-domain links from the page (simple regex, Jina provides markdown links)
  const linkMatches = pageContent.match(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g) ?? [];
  const candidateLinks = linkMatches
    .map((m) => {
      const match = m.match(/\]\((https?:\/\/[^)]+)\)/);
      return match ? match[1] : null;
    })
    .filter((u): u is string => !!u && !visitedUrls.has(u))
    .slice(0, 30); // limit candidates to avoid huge prompts

  if (candidateLinks.length === 0) {
    return { shouldStop: true, linksToFollow: [] };
  }

  const prompt = `You are helping extract data from a website.

Objective: ${objective}
Missing fields still needed: ${missingFields.join(", ")}

Available links on the current page (pick the most likely to contain missing data):
${candidateLinks.map((u, i) => `${i + 1}. ${u}`).join("\n")}

Which of these links should be followed to find the missing fields? Pick at most 3.
If none are useful or all data has been found, set shouldStop=true.

Return ONLY valid JSON: {"shouldStop":boolean,"linksToFollow":["url1","url2"]}`;

  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "link_decision",
          strict: true,
          schema: {
            type: "object",
            properties: {
              shouldStop: { type: "boolean" },
              linksToFollow: { type: "array", items: { type: "string" } },
            },
            required: ["shouldStop", "linksToFollow"],
            additionalProperties: false,
          },
        },
      },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");
    return {
      shouldStop: parsed.shouldStop ?? true,
      linksToFollow: (parsed.linksToFollow ?? []).filter(
        (u: string) => !visitedUrls.has(u),
      ),
    };
  } catch {
    return { shouldStop: true, linksToFollow: [] };
  }
}

// ---------------------------------------------------------------------------
// 5. Merge extraction results (prefer non-empty values)
// ---------------------------------------------------------------------------

function mergeResults(
  base: Record<string, string>,
  incoming: Record<string, string>,
): Record<string, string> {
  const merged = { ...base };
  for (const [key, val] of Object.entries(incoming)) {
    if (val && val.trim() && (!merged[key] || !merged[key].trim())) {
      merged[key] = val;
    } else if (val && val.trim() && merged[key] && merged[key].trim()) {
      // Append new information with separator if both have content
      merged[key] = `${merged[key]}; ${val}`;
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 6. Main entry point
// ---------------------------------------------------------------------------

/**
 * Scrape a URL with the given objective + custom sections.
 *
 * - If the URL is a directory/listing page → returns entries for "Collected URLs" tab
 * - If the URL is a profile → extracts user-defined fields, follows sub-links
 */
export async function scrapeUrl(
  url: string,
  objective: string,
  sections: AgentSection[],
  systemPrompt: string,
  maxHops = 5,
): Promise<AgentScrapeResult> {
  console.log(`[agentScraper] Starting: ${url}`);

  // Fetch the initial page
  const jinaResult = await fetchViaJina(url);
  if (!jinaResult?.success || !jinaResult.content) {
    console.warn(`[agentScraper] Failed to fetch: ${url}`);
    if (sections.length === 0) return { type: "directory", entries: [] };
    const empty: Record<string, string> = {};
    for (const s of sections) empty[s.key] = "";
    return { type: "profile", data: empty };
  }

  const content = jinaResult.content;

  // Classify the page
  const classification = await classifyPage(content, url, objective);
  console.log(`[agentScraper] Page type: ${classification.type} (${classification.reasoning})`);

  // ── DIRECTORY ──────────────────────────────────────────────────────────────
  if (classification.type === "directory") {
    const dirResult = await extractDirectory(url, {
      entryLabel: classification.entityLabel,
      maxPages: 10,
      delayMs: 500,
    });
    const entries: DirectoryEntry[] = dirResult.entries.map((e: DirEntry) => ({
      name: e.name,
      directoryUrl: e.url,
      nativeUrl: undefined,
    }));
    console.log(`[agentScraper] Directory: ${entries.length} entries found`);
    return { type: "directory", entries };
  }

  // ── DIRECTORY-ENTRY ────────────────────────────────────────────────────────
  if (classification.type === "directory-entry") {
    const nativeUrl = await extractNativeUrl(content, url);
    // Also extract basic profile fields if sections are defined
    let data: Record<string, string> = {};
    if (sections.length > 0) {
      data = await extractProfileFields(content, sections, systemPrompt);
    }
    const entry: DirectoryEntry = {
      name: data["company_name"] ?? data["name"] ?? "",
      directoryUrl: url,
      nativeUrl,
    };
    console.log(`[agentScraper] Directory-entry: nativeUrl=${nativeUrl}`);
    // Return as directory (single entry) so it ends up in "Collected URLs" tab
    return { type: "directory", entries: [entry] };
  }

  // ── PROFILE ────────────────────────────────────────────────────────────────
  if (sections.length === 0) {
    return { type: "profile", data: {} };
  }

  const visitedUrls = new Set<string>([url]);

  // Initial extraction from the homepage
  let data = await extractProfileFields(content, sections, systemPrompt);
  let currentContent = content;

  for (let hop = 0; hop < maxHops; hop++) {
    const decision = await decideNextLinks(
      data,
      sections,
      currentContent,
      objective,
      visitedUrls,
    );

    if (decision.shouldStop || decision.linksToFollow.length === 0) {
      console.log(`[agentScraper] Stopping after ${hop} hops (done or no useful links)`);
      break;
    }

    console.log(`[agentScraper] Following ${decision.linksToFollow.length} link(s) at hop ${hop + 1}`);

    for (const link of decision.linksToFollow.slice(0, 3)) {
      if (visitedUrls.has(link)) continue;
      visitedUrls.add(link);

      const subResult = await fetchViaJina(link);
      if (!subResult?.success || !subResult.content) continue;

      currentContent = subResult.content; // use last fetched page for next link decision
      const subData = await extractProfileFields(subResult.content, sections, systemPrompt);
      data = mergeResults(data, subData);
    }
  }

  console.log(`[agentScraper] Profile extracted (${visitedUrls.size} pages visited)`);
  return { type: "profile", data };
}
