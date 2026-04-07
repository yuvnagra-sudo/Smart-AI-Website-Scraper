/**
 * Agentic Scraper — Plan-Act-Observe-Reflect Loop
 *
 * Replaces the old fixed pipeline (fetch → classify → extract → 5 hops → done)
 * with a true agent loop that:
 *
 *   1. PLAN   — LLM decides the next action (fetch_url | web_search | done)
 *   2. ACT    — Execute the action
 *   3. OBSERVE — Extract all fields from the result, score confidence per field
 *   4. REFLECT — If all fields are confident enough, stop. Otherwise, loop.
 *
 * Key improvements over the old pipeline:
 *   - No classifyPage() — the agent never misclassifies a company site as a directory
 *   - Web search fallback — if the website has no data, search the web
 *   - Per-field confidence scoring — stops when it has enough, not when a counter hits 0
 *   - Source attribution — every field value records which URL it came from
 *   - Intent-aware — always knows it is enriching a specific company, not crawling
 *
 * The old classifyPage / directory-expansion path is preserved as a separate
 * opt-in export (scrapeUrlAsDirectory) for the "Collected URLs" tab use-case.
 */

import { fetchViaJina, fetchWebsiteContentHybrid } from "./jinaFetcher";
import { extractDirectory, type DirectoryEntry as DirEntry } from "./directoryExtractor";
import { queuedLLMCall } from "./_core/llmQueue";
import { webSearch, searchQueryForField, searchQueryVariant } from "./_core/webSearch";
import type { SkillContext } from "../shared/skillContext";
import { preLLMExtract, preLLMExtractFull, CONFIDENCE } from "./preLLMExtractor";
import { enrichWithLinkedIn } from "./dataSources/apifyLinkedin";
import { hunterDomainSearch } from "./dataSources/hunterApi";
import { smtpVerifyGenericEmail, shouldRunSmtpFallback } from "./dataSources/smtpVerify";
import { mapUrlsHeuristic, mapUrlsWithLLM, generateTeamPageCandidates, type MappedUrl } from "./mapPhase";
import { getProfile, getSection, getSubSection, type AgentProfile } from "./agentConfig";
import { getCachedFetch, setCachedFetch } from "./fetchCache";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentSection {
  key: string;
  label: string;
  desc: string;
  /**
   * Optional: defines this section as an array of structured objects.
   * When set, extraction returns a JSON array instead of a flat string.
   * Example: { "name": "string", "title": "string", "linkedin": "string" }
   * The Excel processor expands these into multiple rows/columns.
   */
  arraySchema?: Record<string, "string" | "number">;
  /** Maximum number of items when arraySchema is set (default: 10). */
  arrayMaxItems?: number;
}

export interface DirectoryEntry {
  name: string;
  directoryUrl: string;
  nativeUrl?: string;
}

export interface ScrapeStats {
  fieldsTotal: number;
  fieldsFilled: number;
  emptyFields: string[];
}

/**
 * Per-field extraction result with a confidence score and citation.
 * confidence: 0.0 = not found / guessed, 1.0 = explicitly stated on page.
 * The agent loop uses this to decide whether to keep searching.
 */
export interface FieldResult {
  value: string;
  confidence: number; // 0.0 – 1.0
  sourceUrl?: string; // which URL this value was extracted from
  /** The extraction source method (for deterministic confidence scoring). */
  extractionMethod?: "json_ld" | "css_pattern" | "regex" | "llm_cited" | "llm_uncited" | "search_snippet";
  /** Exact text snippet from the page that grounds this extraction (anti-hallucination). */
  quoteSource?: string;
}

/** Map of field key → FieldResult */
export type FieldResultMap = Record<string, FieldResult>;

/** Confidence threshold: fields below this are considered "needs more search".
 * Sourced from the active agent profile (default: 0.7). */
export const CONFIDENCE_THRESHOLD = getProfile().confidenceThreshold;

export type AgentScrapeResult =
  | { type: "directory"; entries: DirectoryEntry[] }
  | {
      type: "profile";
      data: Record<string, string>;
      fieldResults: FieldResultMap;
      stats: ScrapeStats;
      /** Per-URL data returned by PageCallbacks.onPageFetched. Only populated when callbacks are used. */
      extras?: Record<string, unknown>;
    };

/**
 * Optional callbacks passed to scrapeUrl() as the 7th parameter.
 * Existing callers that pass only 6 positional args are unaffected.
 */
export interface PageCallbacks {
  /**
   * Called after every page that scrapeUrl() successfully fetches.
   * Runs BEFORE the generic extractProfileFields() LLM pass.
   *
   * Return null to let the generic pass handle everything.
   * Return a result object to store specialised data in extras[url].
   * Set skipGenericExtraction: true to skip extractProfileFields() for this page.
   */
  onPageFetched?: (
    url: string,
    content: string,
  ) => Promise<{ data: unknown; skipGenericExtraction?: boolean } | null>;
}

// ---------------------------------------------------------------------------
// Agent action types
// ---------------------------------------------------------------------------

type AgentAction =
  | { action: "fetch_url"; target: string; reason: string }
  | { action: "web_search"; query: string; reason: string }
  | { action: "done"; reason: string };

// ---------------------------------------------------------------------------
// 1. PLAN — LLM decides what to do next
// ---------------------------------------------------------------------------

async function planNextAction(
  companyName: string,
  websiteUrl: string,
  objective: string,
  sections: AgentSection[],
  fieldResults: FieldResultMap,
  visitedUrls: Set<string>,
  availableLinks: string[],
  hopsUsed: number,
  maxHops: number,
  skillContext?: SkillContext | null,
  webSearchedFields?: Set<string>,
  failedDomains?: Map<string, number>,
): Promise<AgentAction> {
  // Build a summary of current state
  const fieldSummary = sections.map(s => {
    const r = fieldResults[s.key];
    const conf = r ? r.confidence.toFixed(2) : "0.00";
    const val = r?.value ? `"${r.value.slice(0, 60)}${r.value.length > 60 ? "..." : ""}"` : "(empty)";
    return `  ${s.key} [conf=${conf}]: ${val}`;
  }).join("\n");

  const weakFields = sections.filter(s => (fieldResults[s.key]?.confidence ?? 0) < CONFIDENCE_THRESHOLD);
  const allDone = weakFields.length === 0;

  if (allDone || hopsUsed >= maxHops) {
    return { action: "done", reason: allDone ? "All fields have sufficient confidence" : "Max hops reached" };
  }

  const visitedList = [...visitedUrls].slice(-10).join("\n  ");
  const linkList = availableLinks.slice(0, 20).join("\n  ");
  const weakList = weakFields.map(s => `${s.key} (${s.label})`).join(", ");

  // Build link hints from profile based on what fields are missing
  const profile = getProfile();
  const peoplePattern = new RegExp(profile.peopleFieldPattern, "i");
  const techPattern = new RegExp(profile.techFieldPattern, "i");
  const domainPattern = new RegExp(profile.domainFieldPattern, "i");

  const needsPeople = weakFields.some(s => peoplePattern.test(s.key + " " + s.label));
  const needsTechScore = weakFields.some(s => techPattern.test(s.key + " " + s.label));
  const needsDomain = weakFields.some(s => domainPattern.test(s.key + " " + s.label));

  // Source link hints from profile
  const linkHintsSection = getSection(profile, "Link Priority Hints");
  const linkHints = needsPeople
    ? (linkHintsSection.match(/People\/contacts needed:\s*(.+)/i)?.[1] ?? "PRIORITY LINKS: prefer /about, /team, /people, /leadership")
    : needsTechScore
    ? (linkHintsSection.match(/Tech assessment needed:\s*(.+)/i)?.[1] ?? "PRIORITY LINKS: prefer /services, /work, /portfolio")
    : needsDomain
    ? (linkHintsSection.match(/Domain\/website needed:\s*(.+)/i)?.[1] ?? "PRIORITY LINKS: prefer the company homepage")
    : (linkHintsSection.match(/Default:\s*(.+)/i)?.[1] ?? "PRIORITY LINKS: prefer pages most likely to contain the missing fields listed above");

  // Source urgency thresholds from profile
  const hopsRemaining = maxHops - hopsUsed;
  const urgencySection = getSection(profile, "Urgency Thresholds");
  let urgency = "";
  if (hopsRemaining <= 1) {
    const tmpl = urgencySection.match(/1 hop remaining:\s*(.+)/i)?.[1] ?? `URGENT: Only ${hopsRemaining} hop(s) remaining. If no good link is available, use web_search immediately.`;
    urgency = tmpl.replace("{hopsRemaining}", String(hopsRemaining));
  } else if (hopsRemaining <= 2) {
    const tmpl = urgencySection.match(/2 hops remaining:\s*(.+)/i)?.[1] ?? `${hopsRemaining} hops remaining. Be selective.`;
    urgency = tmpl.replace("{hopsRemaining}", String(hopsRemaining));
  }

  const skillBlock = skillContext ? `
ICP: ${skillContext.icpSummary}
Goal: ${skillContext.outreachGoal}
Target decision makers: ${skillContext.targetTitles.join(", ")}
Fit signals (look for these): ${skillContext.fitSignals.join(", ")}
Skip if company shows: ${skillContext.exclusionSignals.join(", ")}
` : "";

  const searchedList = webSearchedFields && webSearchedFields.size > 0
    ? Array.from(webSearchedFields).join(", ")
    : "(none yet)";

  // Source agent persona and decision rules from profile
  const agentPersona = getSection(profile, "Agent Persona");
  const decisionRules = getSection(profile, "Planner Decision Rules")
    .replace("{companyName}", companyName)
    .replace("{domain}", websiteUrl.replace(/https?:\/\//, "").split("/")[0]);

  // Build a summary of already-found values so the LLM can craft context-aware queries
  const foundValuesSummary = sections
    .filter(s => (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD)
    .map(s => `  ${s.label}: "${(fieldResults[s.key]?.value ?? "").slice(0, 80)}"`)
    .join("\n");

  const prompt = `${agentPersona}

Company: ${companyName}
Website: ${websiteUrl}
Objective: ${objective}${skillBlock ? "\n" + skillBlock : ""}

Current extraction state (confidence 0.0=not found, 1.0=certain):
${fieldSummary}

Missing fields (need confidence >= ${CONFIDENCE_THRESHOLD}): ${weakList}

Already found (use these to build precise search queries):
${foundValuesSummary || "  (none yet)"}

URLs already visited — DO NOT revisit these:
  ${visitedList || "(none yet)"}

Available links from last page:
  ${linkList || "(none — use web_search)"}

Fields already attempted via web_search — DO NOT search again for these:
  ${searchedList}

Hops used: ${hopsUsed} / ${maxHops}${urgency ? "\n" + urgency : ""}
${failedDomains && failedDomains.size > 0 ? `\nDomains with repeated fetch failures (prefer web_search over fetch_url for these):\n  ${Array.from(failedDomains.entries()).filter(([, c]) => c >= 2).map(([d, c]) => `${d} (${c} failures)`).join(", ") || "(none)"}` : ""}

${linkHints}

${decisionRules}

WEB SEARCH QUERY GUIDANCE (apply when action is web_search):
- Use specific, targeted queries that combine company name + the exact field you need
- Incorporate already-found values to narrow results (e.g. if you know the CEO name, search for their email)
- Prefer queries like: "${companyName}" CEO email, "${companyName}" founder LinkedIn, site:linkedin.com "${companyName}" CEO
- Avoid generic queries like "${companyName} info" — be precise about what is missing
- Use quotes around proper nouns for exact matching

Return ONLY valid JSON (no markdown):
{"action":"fetch_url"|"web_search"|"done","target":"full URL if fetch_url, else null","query":"precise search query if web_search, else null","reason":"one sentence explaining why this is the best next step"}`;

  try {
    const response = await queuedLLMCall({
      model: profile.planningModel,
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "agent_action",
          strict: true,
          schema: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["fetch_url", "web_search", "done"] },
              target: { type: ["string", "null"] },
              query: { type: ["string", "null"] },
              reason: { type: "string" },
            },
            required: ["action", "target", "query", "reason"],
            additionalProperties: false,
          },
        },
      },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");

    if (parsed.action === "fetch_url" && parsed.target) {
      // Validate the URL is not already visited
      if (visitedUrls.has(parsed.target)) {
        console.log(`[agentScraper] PLAN: LLM chose already-visited URL, switching to web_search`);
        const weakField = weakFields[0];
        // Use searchQueryVariant for diversification on fallback
        return {
          action: "web_search",
          query: searchQueryVariant(companyName, websiteUrl, weakField.label, webSearchedFields?.size ?? 0),
          reason: "Chosen URL already visited, falling back to diversified web search",
        };
      }
      return { action: "fetch_url", target: parsed.target, reason: parsed.reason ?? "" };
    }

    if (parsed.action === "web_search") {
      // Use LLM-generated query if present and non-trivial; otherwise fall back to variant
      const llmQuery = parsed.query?.trim();
      const query = (llmQuery && llmQuery.length > 5)
        ? llmQuery
        : searchQueryVariant(companyName, websiteUrl, weakFields[0]?.label ?? "company info", webSearchedFields?.size ?? 0);
      return { action: "web_search", query, reason: parsed.reason ?? "" };
    }

    return { action: "done", reason: parsed.reason ?? "LLM decided done" };
  } catch (err) {
    console.error("[agentScraper] planNextAction error:", err instanceof Error ? err.message : String(err).slice(0, 200));
    return { action: "done", reason: "Planning error — stopping safely" };
  }
}

// ---------------------------------------------------------------------------
// 2. OBSERVE — extract fields from page content (with confidence + source)
// ---------------------------------------------------------------------------

export async function extractProfileFields(
  content: string,
  sections: AgentSection[],
  systemPrompt: string,
  sourceUrl?: string,
  pageType?: "directory" | "company" | "search",
  skillContext?: SkillContext | null,
  /** Raw HTML for pre-LLM extraction (if available, separate from markdown content). */
  rawHtml?: string,
): Promise<FieldResultMap> {
  // ── PRE-LLM EXTRACTION PASS ──────────────────────────────────────────────
  // Run deterministic extraction before the LLM to harvest structured data
  // at high confidence without risking hallucination.
  let preLLMResults: FieldResultMap = {};
  if (rawHtml && pageType !== "search") {
    preLLMResults = preLLMExtract(rawHtml, sections, sourceUrl);
  }

  // Determine which sections still need LLM extraction
  // (fields already extracted with high confidence are skipped)
  const sectionsForLLM = sections.filter(s => {
    const preLLM = preLLMResults[s.key];
    return !preLLM || preLLM.confidence < CONFIDENCE_THRESHOLD;
  });

  // If pre-LLM extracted everything, skip the LLM call entirely
  if (sectionsForLLM.length === 0) {
    console.log(`[agentScraper] Pre-LLM extracted all ${sections.length} fields — skipping LLM call`);
    return preLLMResults;
  }

  // Separate scalar vs array sections for different schema handling
  const scalarSections = sectionsForLLM.filter(s => !s.arraySchema);
  const arraySections = sectionsForLLM.filter(s => s.arraySchema);

  // Build per-section schema properties — now includes quote_source for grounding
  const props: Record<string, Record<string, unknown>> = {};
  for (const s of scalarSections) {
    props[s.key] = {
      type: "object",
      description: `${s.label}: ${s.desc}`,
      properties: {
        value: { type: "string" },
        confidence: { type: "number" },
        quote_source: { type: "string" },
      },
      required: ["value", "confidence", "quote_source"],
      additionalProperties: false,
    };
  }

  // Array sections get a strict array-of-objects schema
  for (const s of arraySections) {
    const itemProps: Record<string, { type: string }> = {};
    const itemRequired: string[] = [];
    for (const [fieldName, fieldType] of Object.entries(s.arraySchema!)) {
      itemProps[fieldName] = { type: fieldType };
      itemRequired.push(fieldName);
    }
    // Add quote_source to each array item for grounding
    itemProps["quote_source"] = { type: "string" };
    itemRequired.push("quote_source");

    props[s.key] = {
      type: "object",
      description: `${s.label}: ${s.desc}. Return as a structured array.`,
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: itemProps,
            required: itemRequired,
            additionalProperties: false,
          },
        },
        confidence: { type: "number" },
      },
      required: ["items", "confidence"],
      additionalProperties: false,
    };
  }

  // Build a brief example from the first 2 sections so the LLM sees expected format
  const exampleObj: Record<string, { value: string; confidence: number; quote_source: string }> = {};
  for (const s of sectionsForLLM.slice(0, 2)) {
    exampleObj[s.key] = { value: `[extracted ${s.label.toLowerCase()} from page]`, confidence: 0.9, quote_source: `[exact text from page containing ${s.label.toLowerCase()}]` };
  }
  for (const s of sectionsForLLM.slice(2)) {
    exampleObj[s.key] = { value: "", confidence: 0.0, quote_source: "" };
  }
  const exampleJson = JSON.stringify(exampleObj, null, 2);

  // Source all prompt intelligence from the agent profile
  const extractProfile = getProfile();

  // Page-type guidance from profile
  const pageTypeKey = pageType === "directory" ? "Directory" : pageType === "search" ? "Search" : "Company";
  const pageTypeGuidance = getSubSection(extractProfile, "Page Type Confidence Guidance", pageTypeKey);

  // Decision-maker tier guidance from profile
  const dmPriorityGuidance = getSection(extractProfile, "Decision Maker Tiers");

  // Job-specific skill context guidance (overrides generic DM tier when provided)
  const skillContextGuidance = skillContext ? `

━━━ JOB-SPECIFIC TARGETING (overrides generic tier rules above) ━━━
This job is targeting: ${skillContext.icpSummary}
Goal: ${skillContext.outreachGoal}

Decision maker priority for THIS job (in order):
${skillContext.targetTitles.map((t: string, i: number) => `  ${i + 1}. ${t}`).join("\n")}

Fit signals — these indicate a GOOD match (increase confidence for relevant fields):
  ${skillContext.fitSignals.join(", ")}

Exclusion signals — if these are prominent, deprioritize this company:
  ${skillContext.exclusionSignals.join(", ")}` : "";

  // Field format hints from profile (replaces buildFieldTypeHints function)
  const fieldTypeHints = getSection(extractProfile, "Field Format Hints");

  // Critical extraction rules from profile
  const extractionRules = getSection(extractProfile, "Critical Extraction Rules")
    .replace(/\{sourceUrl\}/g, sourceUrl ?? "the target company");

  // Note which fields were already extracted by pre-LLM pass
  const preLLMNote = Object.entries(preLLMResults)
    .filter(([, r]) => r.value && r.confidence >= CONFIDENCE_THRESHOLD)
    .map(([key]) => key);
  const preLLMSkipNote = preLLMNote.length > 0
    ? `\nNote: The following fields were already extracted from structured data (JSON-LD/CSS) and do NOT need extraction: ${preLLMNote.join(", ")}\nOnly extract the remaining fields listed below.`
    : "";

  // Build a structured field list so the LLM knows exactly what to look for
  const fieldList = sectionsForLLM.map(s => `  - ${s.key} ("${s.label}"): ${s.desc}`).join("\n");

  const userMsg = `${systemPrompt}

${pageTypeGuidance}

${dmPriorityGuidance}${skillContextGuidance}

━━━ FIELD FORMAT HINTS ━━━
Use these hints to recognize and correctly extract each field type:
${fieldTypeHints}
${preLLMSkipNote}

━━━ CRITICAL EXTRACTION RULES ━━━
${extractionRules}

━━━ FIELDS TO EXTRACT ━━━
${fieldList}

━━━ PAGE CONTENT (source: ${sourceUrl || 'unknown'}) ━━━
${content.substring(0, 60000)}

━━━ EXTRACTION INSTRUCTIONS ━━━
Before writing your JSON answer, reason through the page carefully for each field.
For each field:
  1. SEARCH: Scan the page content for any text relevant to this field.
  2. EVALUATE: Is the text about the target company itself (not a client, reviewer, or partner)?
  3. SYNTHESIZE: What is the best single value to return? If multiple values exist, pick the most prominent or authoritative one.
  4. CITE: Copy the exact 10-100 character snippet from the page that contains this value.
  5. SCORE: Assign confidence (1.0=explicitly stated, 0.8=clearly implied, 0.6=inferred from context, 0.4=uncertain, 0.0=not found).

If a field is not found anywhere on the page, return value="" confidence=0.0 quote_source="". NEVER guess or hallucinate.
If the extracted value is in a language other than English, translate it to English before returning it in the "value" field. The "quote_source" field should still contain the original text from the page.

For each field, return:
- "value": exact extracted text, or "" if not found
- "confidence": 0.0-1.0
- "quote_source": exact text snippet from the page (10-100 chars), or "" if not found

Example output format:
${exampleJson}

Return ONLY valid JSON with these keys: ${sectionsForLLM.map((s) => s.key).join(", ")}`;

  try {
    const response = await queuedLLMCall({
      model: extractProfile.extractionModel,
      messages: [{ role: "user", content: userMsg }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "field_extraction",
          strict: true,
          schema: {
            type: "object",
            properties: props,
            required: sectionsForLLM.map((s) => s.key),
            additionalProperties: false,
          },
        },
      },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");

    // Build FieldResultMap with deterministic confidence scoring + citation validation
    const result: FieldResultMap = { ...preLLMResults };
    const contentLower = content.toLowerCase();
    const normalizedContent = contentLower.replace(/\s+/g, " ");

    for (const s of sectionsForLLM) {
      const field = parsed[s.key];

      // ── ARRAY SECTION HANDLING ──────────────────────────────────────────
      if (s.arraySchema) {
        const items = Array.isArray(field?.items) ? field.items : [];
        const llmConfidence = typeof field?.confidence === "number"
          ? Math.max(0, Math.min(1, field.confidence))
          : items.length > 0 ? 0.5 : 0.0;

        if (items.length === 0) {
          result[s.key] = { value: "", confidence: 0.0, sourceUrl, extractionMethod: "llm_uncited" };
          continue;
        }

        // Validate citations for each array item (fuzzy matching like scalar fields)
        const validatedItems = items.map((item: Record<string, unknown>) => {
          const quoteSource = String(item.quote_source ?? "").trim();
          let citationValid = false;
          if (quoteSource && quoteSource.length >= 5) {
            const normalizedQuote = quoteSource.toLowerCase().replace(/\s+/g, " ");
            if (normalizedContent.includes(normalizedQuote)) {
              citationValid = true;
            } else {
              const quoteWords = normalizedQuote.split(/\s+/).filter((w: string) => w.length > 2);
              if (quoteWords.length > 0) {
                const matchedWords = quoteWords.filter((w: string) => normalizedContent.includes(w));
                citationValid = matchedWords.length / quoteWords.length >= 0.6;
              }
            }
          }
          // Also check if the item's name/value appears in content
          const itemName = String(item.name ?? "").trim().toLowerCase();
          if (!citationValid && itemName.length >= 3 && normalizedContent.includes(itemName)) {
            citationValid = true;
          }
          const { quote_source, ...itemData } = item;
          return { data: itemData, citationValid };
        });

        // Keep all items — don't discard uncited ones. Citation affects confidence, not inclusion.
        const filteredItems = validatedItems;

        if (filteredItems.length === 0 && validatedItems.length > 0) {
          console.warn(`[agentScraper] ⚠️ All ${validatedItems.length} items for ${s.key} failed citation validation — discarding as likely hallucinations`);
          result[s.key] = { value: "", confidence: 0.0, sourceUrl, extractionMethod: "llm_uncited" };
          continue;
        }

        // Serialize array as JSON string for storage (Excel processor will parse it)
        const value = JSON.stringify(filteredItems.map((i: { data: Record<string, unknown>; citationValid: boolean }) => i.data));
        const citedCount = filteredItems.filter((i: { data: Record<string, unknown>; citationValid: boolean }) => i.citationValid).length;
        const adjustedConfidence = citedCount === filteredItems.length ? 0.90 : Math.min(llmConfidence, 0.70);

        result[s.key] = {
          value,
          confidence: adjustedConfidence,
          sourceUrl,
          extractionMethod: citedCount > 0 ? "llm_cited" : "llm_uncited",
        };
        continue;
      }

      // ── SCALAR SECTION HANDLING ─────────────────────────────────────────
      const value = String(field?.value ?? "").trim();
      const quoteSource = String(field?.quote_source ?? "").trim();
      const llmConfidence = typeof field?.confidence === "number"
        ? Math.max(0, Math.min(1, field.confidence))
        : value ? 0.5 : 0.0;

      if (!value) {
        result[s.key] = { value: "", confidence: 0.0, sourceUrl, extractionMethod: "llm_uncited" };
        continue;
      }

      // ── CITATION POST-VALIDATION ────────────────────────────────────────
      // Check if the quote_source exists in the page content.
      // Uses fuzzy matching: tries exact match first, then word-overlap.
      // Markdown rendering changes whitespace/punctuation, so exact matches
      // fail ~30-40% of the time even on valid extractions.
      let citationValid = false;
      if (quoteSource && quoteSource.length >= 5) {
        const normalizedQuote = quoteSource.toLowerCase().replace(/\s+/g, " ").trim();
        // Try exact substring match first
        if (normalizedContent.includes(normalizedQuote)) {
          citationValid = true;
        } else {
          // Fuzzy fallback: check if 60%+ of the quote's words appear near each other in content
          const quoteWords = normalizedQuote.split(/\s+/).filter(w => w.length > 2);
          if (quoteWords.length > 0) {
            const matchedWords = quoteWords.filter(w => normalizedContent.includes(w));
            citationValid = matchedWords.length / quoteWords.length >= 0.6;
          }
        }
      }
      // Also accept: if the extracted VALUE itself appears in the content, treat as cited
      if (!citationValid && value.length >= 3) {
        const normalizedValue = value.toLowerCase().replace(/\s+/g, " ").trim();
        if (normalizedContent.includes(normalizedValue)) {
          citationValid = true;
        }
      }

      // ── DETERMINISTIC CONFIDENCE SCORING ────────────────────────────────
      // Override LLM's self-assessed confidence with source-based scoring.
      // All thresholds sourced from the active agent profile.
      const co = extractProfile.confidenceOverrides;
      let adjustedConfidence: number;
      let extractionMethod: FieldResult["extractionMethod"];

      if (pageType === "directory") {
        adjustedConfidence = citationValid ? (co.directory_cited ?? 0.95) : Math.min(llmConfidence, co.directory_uncited ?? 0.85);
        extractionMethod = citationValid ? "llm_cited" : "llm_uncited";
      } else if (pageType === "search") {
        adjustedConfidence = citationValid ? (co.search_cited ?? 0.60) : Math.min(llmConfidence, co.search_uncited ?? 0.45);
        extractionMethod = "search_snippet";
      } else {
        if (citationValid) {
          adjustedConfidence = Math.min(co.company_cited ?? 0.90, Math.max(llmConfidence, co.company_cited_min ?? 0.85));
          extractionMethod = "llm_cited";
        } else if (quoteSource) {
          adjustedConfidence = Math.min(llmConfidence, co.company_uncited_with_quote ?? 0.40);
          extractionMethod = "llm_uncited";
          console.warn(`[agentScraper] ⚠️ Citation mismatch for ${s.key}: quote "${quoteSource.slice(0, 50)}..." not found in page`);
        } else {
          adjustedConfidence = Math.min(llmConfidence, co.company_uncited_no_quote ?? 0.50);
          extractionMethod = "llm_uncited";
        }
      }

      result[s.key] = {
        value,
        confidence: adjustedConfidence,
        sourceUrl,
        extractionMethod,
        quoteSource: citationValid ? quoteSource : undefined,
      };
    }

    // Ensure all sections have entries (including pre-LLM results)
    for (const s of sections) {
      if (!result[s.key]) {
        result[s.key] = { value: "", confidence: 0.0, sourceUrl };
      }
    }

    return result;
  } catch (err) {
    console.error("[agentScraper] extractProfileFields error:", err instanceof Error ? err.message : String(err).slice(0, 200));
    // On error, return pre-LLM results (better than nothing)
    const fallback: FieldResultMap = { ...preLLMResults };
    for (const s of sections) {
      if (!fallback[s.key]) fallback[s.key] = { value: "", confidence: 0.0, sourceUrl };
    }
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// 3. REFLECT — merge two FieldResultMaps, keeping the higher-confidence value
// ---------------------------------------------------------------------------

/** Extraction method reliability ranking — sourced from active agent profile. */
const METHOD_RANK: Record<string, number> = getProfile().methodRank;

function getMethodRank(method?: string): number {
  return METHOD_RANK[method ?? "llm_uncited"] ?? 1;
}

function mergeFieldResults(base: FieldResultMap, incoming: FieldResultMap): FieldResultMap {
  const merged: FieldResultMap = { ...base };
  for (const [key, incomingResult] of Object.entries(incoming)) {
    const existing = merged[key];
    if (!existing) { merged[key] = incomingResult; continue; }

    const incomingVal = incomingResult.value?.trim() ?? "";
    const existingVal = existing.value?.trim() ?? "";

    // If incoming is empty, keep existing
    if (!incomingVal) continue;

    // If existing is empty, use incoming
    if (!existingVal) { merged[key] = incomingResult; continue; }

    // Both have content — prefer by: (1) extraction method reliability, (2) confidence, (3) length
    const incomingRank = getMethodRank(incomingResult.extractionMethod);
    const existingRank = getMethodRank(existing.extractionMethod);

    // Deterministic source always beats LLM-inferred
    if (incomingRank > existingRank) {
      merged[key] = incomingResult;
      continue;
    }
    if (existingRank > incomingRank) continue;

    // Same method type — prefer higher confidence
    if (incomingResult.confidence > existing.confidence) {
      merged[key] = incomingResult;
      continue;
    }

    // Same confidence — prefer cited over uncited
    if (incomingResult.quoteSource && !existing.quoteSource) {
      merged[key] = incomingResult;
      continue;
    }

    // Same confidence — prefer longer (more complete) value
    if (incomingResult.confidence === existing.confidence && incomingVal.length > existingVal.length) {
      merged[key] = incomingResult;
      continue;
    }

    // Append if incoming adds genuinely new information (not a substring)
    const existingLower = existingVal.toLowerCase();
    const incomingLower = incomingVal.toLowerCase();
    if (!existingLower.includes(incomingLower) && !incomingLower.includes(existingLower)) {
      // Combine, keeping the higher-confidence source attribution
      const combinedValue = `${existingVal}; ${incomingVal}`;
      const combinedConf = Math.max(existing.confidence, incomingResult.confidence);
      merged[key] = { value: combinedValue, confidence: combinedConf, sourceUrl: existing.sourceUrl, extractionMethod: existing.extractionMethod };
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 4a. Directory-exit helpers — extract the company's real website from a
//     directory profile page before generic link extraction runs.
// ---------------------------------------------------------------------------

/**
 * Known directory domains and their redirect/website-link patterns.
 * For each directory, we define:
 *   - domains: hostnames that identify this directory
 *   - extractWebsite: function that extracts the company's real URL from raw page content
 */
const DIRECTORY_EXTRACTORS: Array<{
  name: string;
  domains: string[];
  extractWebsite: (content: string) => string | null;
}> = [
  {
    // Clutch: wraps links as https://r.clutch.co/redirect?...&provider_website=tbkcreative.com&...&u=http%3A%2F%2F...
    // The `provider_website` param is the cleanest signal; `u=` param has the full URL.
    name: "Clutch",
    domains: ["clutch.co"],
    extractWebsite: (content) => {
      // Strategy 1: extract from `u=` query param inside a Clutch redirect URL (most reliable)
      const uMatch = content.match(/[?&]u=(https?[^&"'\s>)]+)/);
      if (uMatch) {
        try {
          const decoded = new URL(decodeURIComponent(uMatch[1]));
          decoded.searchParams.delete("utm_source");
          decoded.searchParams.delete("utm_medium");
          decoded.searchParams.delete("utm_campaign");
          return decoded.origin + decoded.pathname;
        } catch { /* fall through */ }
      }
      // Strategy 2: extract from `provider_website=` param (domain only — prepend https://)
      const pwMatch = content.match(/provider_website=([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (pwMatch) return `https://${pwMatch[1]}`;
      return null;
    },
  },
  {
    // GoodFirms: company website appears as plain text after "Website:" or as a bare URL
    // in the company info section. GoodFirms does NOT use redirect URLs.
    name: "GoodFirms",
    domains: ["goodfirms.co"],
    extractWebsite: (content) => {
      // Look for "Website: https://..." pattern in the markdown
      const m = content.match(/Website[:\s]+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?)/);
      if (m) return m[1].startsWith("http") ? m[1] : `https://${m[1]}`;
      return null;
    },
  },
  {
    // G2: company website is in a "Visit website" button or "Website" field.
    // G2 uses a redirect: https://www.g2.com/products/X/go?utm_source=...
    name: "G2",
    domains: ["g2.com"],
    extractWebsite: (content) => {
      // G2 redirect: /go?utm_source=... does not contain the target URL in the link itself.
      // Fall back to looking for a bare domain after "Website" label.
      const m = content.match(/(?:Website|website)[:\s]+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (m && !m[1].includes("g2.com")) return `https://${m[1]}`;
      return null;
    },
  },
  {
    // Yelp: company website is in a "Business website" link, sometimes obfuscated via
    // https://www.yelp.com/biz_redir?url=https%3A%2F%2F...
    name: "Yelp",
    domains: ["yelp.com"],
    extractWebsite: (content) => {
      // Strategy 1: biz_redir URL
      const redirMatch = content.match(/biz_redir\?url=(https?[^&"'\s>)]+)/);
      if (redirMatch) {
        try { return decodeURIComponent(redirMatch[1]); } catch { /* fall through */ }
      }
      // Strategy 2: plain text after "Business website"
      const m = content.match(/Business website[:\s]+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (m) return `https://${m[1]}`;
      return null;
    },
  },
  {
    // Capterra: uses /goto/software/... redirect links
    name: "Capterra",
    domains: ["capterra.com"],
    extractWebsite: (content) => {
      // Capterra does not embed the target URL in the redirect path.
      // Fall back to looking for a bare domain after "Website" label.
      const m = content.match(/(?:Website|website)[:\s]+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (m && !m[1].includes("capterra.com")) return `https://${m[1]}`;
      return null;
    },
  },
  {
    // Trustpilot: company website in the business info section
    name: "Trustpilot",
    domains: ["trustpilot.com"],
    extractWebsite: (content) => {
      const m = content.match(/(?:Website|website)[:\s]+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (m && !m[1].includes("trustpilot.com")) return `https://${m[1]}`;
      return null;
    },
  },
];

/**
 * Given a directory page URL and its content, attempt to extract the company's
 * real website URL using directory-specific logic.
 * Returns null if the URL is not a known directory or no website is found.
 */
export function extractCompanyWebsiteFromDirectory(pageUrl: string, content: string): string | null {
  let host = "";
  try { host = new URL(pageUrl).hostname; } catch { return null; }

  for (const extractor of DIRECTORY_EXTRACTORS) {
    if (extractor.domains.some(d => host.includes(d))) {
      const website = extractor.extractWebsite(content);
      if (website) {
        console.log(`[agentScraper] 🏠 ${extractor.name} directory-exit: found company website → ${website}`);
        return website;
      }
    }
  }
  return null;
}

/**
 * Returns true if the given URL is a known directory profile page.
 */
export function isDirectoryUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return DIRECTORY_EXTRACTORS.some(e => e.domains.some(d => host.includes(d)));
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// 4b. Extract available links from page content (for PLAN step)
// ---------------------------------------------------------------------------

function extractLinksFromContent(content: string, baseUrl: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();

  // Noise domains sourced from agent profile + directory extractor domains
  const linkProfile = getProfile();
  const noiseDomains = [
    ...linkProfile.noiseDomains,
    ...DIRECTORY_EXTRACTORS.flatMap(e => e.domains),
  ];
  const isNoise = (u: string) => {
    try { const h = new URL(u).hostname; return noiseDomains.some(d => h.includes(d)); }
    catch { return true; }
  };

  function addLink(raw: string) {
    let url = raw.replace(/[.,;)>\]"']+$/, "");
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;

      // ── Directory redirect decoding ──────────────────────────────────────
      // Clutch: extract from u= param
      if (host.includes("clutch.co")) {
        const uParam = parsed.searchParams.get("u");
        if (uParam) {
          try {
            const decoded = new URL(decodeURIComponent(uParam));
            decoded.searchParams.delete("utm_source");
            decoded.searchParams.delete("utm_medium");
            decoded.searchParams.delete("utm_campaign");
            url = decoded.origin + decoded.pathname;
          } catch { return; }
        } else {
          return; // internal Clutch link — skip
        }
      }
      // Yelp: extract from biz_redir?url=
      else if (host.includes("yelp.com") && parsed.pathname.includes("biz_redir")) {
        const target = parsed.searchParams.get("url");
        if (target) {
          try { url = decodeURIComponent(target); } catch { return; }
        } else { return; }
      }
      // Generic: skip obvious noise (images, CDN, social)
      else if (isNoise(url)) {
        return;
      }
    } catch { return; }

    if (!seen.has(url)) { seen.add(url); links.push(url); }
  }

  // Match markdown-style links: [text](url)
  const mdPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdPattern.exec(content)) !== null) {
    addLink(m[2]);
  }

  // Match bare URLs
  const barePattern = /https?:\/\/[^\s"'<>)\]]+/g;
  while ((m = barePattern.exec(content)) !== null) {
    addLink(m[0]);
  }

  // ── Prioritization ───────────────────────────────────────────────────────
  let baseDomain = "";
  try { baseDomain = new URL(baseUrl).hostname; } catch { /* ignore */ }

  // Tier 1: sub-pages of the same domain as baseUrl (e.g. /about, /team, /contact)
  const sameDomain = links.filter(u => {
    try { return new URL(u).hostname === baseDomain; } catch { return false; }
  });

  // Tier 2: company's own external site (not a directory, not noise)
  const companyLinks = links.filter(u => !sameDomain.includes(u));

  // Within Tier 2, prefer high-value sub-pages (about, team, contact, leadership)
  const HIGH_VALUE_PATHS = ['/about', '/team', '/contact', '/leadership', '/people', '/staff', '/management', '/founders', '/executives'];
  const highValue = companyLinks.filter(u => {
    try { const p = new URL(u).pathname.toLowerCase(); return HIGH_VALUE_PATHS.some(h => p.startsWith(h)); }
    catch { return false; }
  });
  const otherCompany = companyLinks.filter(u => !highValue.includes(u));

  // Order: same-domain sub-pages → high-value company pages → other company pages
  return [...sameDomain, ...highValue, ...otherCompany].slice(0, 50);
}

// ---------------------------------------------------------------------------
// 5. Fetch a URL and return content + extracted links
// ---------------------------------------------------------------------------

async function fetchAndExtract(url: string, isCancelled?: () => boolean): Promise<{ content: string; links: string[]; rawHtml?: string } | null> {
  // Bail immediately if job was cancelled before we even start the fetch
  if (isCancelled?.()) return null;
  // Check shared cache first (cross-firm deduplication)
  const cached = getCachedFetch(url);
  if (cached !== undefined) {
    if (cached) console.log(`[agentScraper] Cache hit: ${url} (${cached.content.length} chars)`);
    return cached;
  }
  let rawHtmlFromPuppeteer: string | null = null;

  const result = await fetchWebsiteContentHybrid(url, async () => {
    try {
      const { scrapeWebsite } = await import("./scraper");
      const r = await scrapeWebsite({ url, cache: true, cacheTTL: 7 * 24 * 60 * 60, timeout: 45000 });
      if (r.success) {
        // Capture raw HTML for pre-LLM extraction (JSON-LD, CSS patterns)
        rawHtmlFromPuppeteer = r.html || null;
        return r.text || r.html || null;
      }
      return null;
    } catch { return null; }
  });

  if (!result?.success || !result.content) {
    setCachedFetch(url, null); // Cache failed fetches too (avoid retrying blocked URLs)
    return null;
  }
  const links = extractLinksFromContent(result.content, url);

  // If Puppeteer was used, we already have raw HTML.
  // If Jina was used (markdown), try a lightweight HTML fetch for JSON-LD extraction.
  let rawHtml: string | undefined = rawHtmlFromPuppeteer ?? undefined;
  if (!rawHtml && result.source === "jina") {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; SmartScraper/1.0)" },
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) {
        const html = await resp.text();
        // Always keep raw HTML for pre-LLM extraction — CSS selectors, meta tags,
        // and mailto/tel links all work on raw HTML even without JSON-LD.
        if (html.length > 500) {
          rawHtml = html;
        }
      }
    } catch {
      // Non-fatal — we'll still have the markdown content for LLM extraction
    }
  }

  const fetchResult = { content: result.content, links, rawHtml };
  setCachedFetch(url, fetchResult);
  return fetchResult;
}

// ---------------------------------------------------------------------------
// 6. Main entry point — Plan-Act-Observe-Reflect loop
// ---------------------------------------------------------------------------

/**
 * Scrape a URL with the given objective + custom sections.
 *
 * This is the new agentic implementation. It runs a Plan-Act-Observe-Reflect
 * loop per company, stopping when all fields have sufficient confidence or
 * the hop limit is reached.
 *
 * The optional `isCancelled` callback is checked at every loop iteration.
 */
export async function scrapeUrl(
  url: string,
  objective: string,
  sections: AgentSection[],
  systemPrompt: string,
  maxHops = 8,
  isCancelled?: () => boolean,
  callbacks?: PageCallbacks,
  skillContext?: SkillContext | null,
  initialFieldValues?: Record<string, { value: string; confidence: number }>,
  knownCompanyName?: string,
): Promise<AgentScrapeResult> {
  console.log(`[agentScraper] 🚀 Starting agent loop: ${url}`);

  // Use the caller-supplied company name if available; fall back to hostname derivation.
  // This is critical — using the real company name dramatically improves web search quality.
  let companyName = "";
  if (knownCompanyName && knownCompanyName.trim()) {
    companyName = knownCompanyName.trim();
  } else {
    try { companyName = new URL(url).hostname.replace(/^www\./, "").split(".")[0]; } catch { companyName = url; }
  }

  // Agent state — pre-seed with initial field values when available
  let fieldResults: FieldResultMap = {};
  for (const s of sections) {
    const hint = initialFieldValues?.[s.key];
    fieldResults[s.key] = hint ?? { value: "", confidence: 0.0 };
  }
  if (initialFieldValues && Object.keys(initialFieldValues).length > 0) {
    const preFilledCount = Object.keys(initialFieldValues).length;
    console.log(`[agentScraper] Pre-seeded ${preFilledCount} fields from initial values`);
  }

  const visitedUrls = new Set<string>();
  let availableLinks: string[] = [];
  let hopsUsed = 0;
  const webSearchedFields = new Set<string>();
  const extras: Record<string, unknown> = {};
  const failedDomains = new Map<string, number>(); // Track fetch failures per domain
  let webSearchAttemptCount = 0; // For query diversification
  // LinkedIn URL found on the primary page (used for post-loop enrichment)
  let companyLinkedinUrl: string | null = null;

  // ── STEP 0: Fetch the primary URL first (always) ──────────────────────────
  // Check cancellation before the first (potentially slow) fetch
  if (isCancelled?.()) throw new Error("JOB_CANCELLED");
  console.log(`[agentScraper] Fetching primary URL: ${url}`);
  const primary = await fetchAndExtract(url, isCancelled);

  if (!primary) {
    console.warn(`[agentScraper] ❌ Primary URL fetch failed: ${url} — will rely on web search`);
  } else {
    visitedUrls.add(url);
    availableLinks = primary.links;

    // Run specialized page callback before generic extraction
    let skipGenericForPrimary = false;
    if (callbacks?.onPageFetched) {
      const cbResult = await callbacks.onPageFetched(url, primary.content);
      if (cbResult) {
        extras[url] = cbResult.data;
        skipGenericForPrimary = cbResult.skipGenericExtraction ?? false;
      }
    }

    // Capture LinkedIn URL from primary page HTML (free — no API cost)
    if (primary.rawHtml) {
      const { companyLinkedinUrl: liUrl } = preLLMExtractFull(primary.rawHtml, sections, url);
      if (liUrl) {
        companyLinkedinUrl = liUrl;
        console.log(`[agentScraper] Found LinkedIn URL on primary page: ${liUrl}`);
      }
    }

    if (!skipGenericForPrimary && sections.length > 0) {
      const extracted = await extractProfileFields(
        primary.content, sections, systemPrompt, url,
        isDirectoryUrl(url) ? "directory" : "company",
        skillContext,
        primary.rawHtml,
      );
      fieldResults = mergeFieldResults(fieldResults, extracted);
      const filled = sections.filter(s => (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD).length;
      console.log(`[agentScraper] Primary page: ${filled}/${sections.length} fields confident`);
    }
    hopsUsed++;

    // ── DIRECTORY-EXIT FAST PATH ─────────────────────────────────────────────
    // If the primary URL is a known directory (Clutch, G2, GoodFirms, etc.),
    // extract the company's real website URL immediately and inject it at the
    // FRONT of availableLinks so the agent visits it on the very next hop.
    // This avoids wasting hops on planNextAction trying to figure out where to go.
    if (isDirectoryUrl(url)) {
      const companyWebsite = extractCompanyWebsiteFromDirectory(url, primary.content);
      if (companyWebsite && !visitedUrls.has(companyWebsite)) {
        availableLinks = [companyWebsite, ...availableLinks.filter(l => l !== companyWebsite)];
        console.log(`[agentScraper] 📌 Directory-exit: injected company website at top of queue: ${companyWebsite}`);
      } else if (!companyWebsite) {
        // Directory-exit fallback: regex extraction failed, use web search to find real site
        console.log(`[agentScraper] 📌 Directory-exit failed — searching for company website`);
        try {
          const fallbackResults = await webSearch(`${companyName} official website`, 3);
          const dirDomains = DIRECTORY_EXTRACTORS.flatMap(e => e.domains);
          const realSite = fallbackResults.find(r => !dirDomains.some(d => r.url.includes(d)));
          if (realSite && !visitedUrls.has(realSite.url)) {
            availableLinks = [realSite.url, ...availableLinks];
            console.log(`[agentScraper] 📌 Directory fallback: found company website via search → ${realSite.url}`);
          }
        } catch { /* Non-fatal */ }
      }
    }

    // ── MAP PHASE: Structured URL Discovery ───────────────────────────────────
    // Replace the ad-hoc "people boost" with a structured map phase that
    // classifies all available links by content type and prioritizes them.
    const mappedUrls = mapUrlsHeuristic(availableLinks, url, sections);
    const hasTeamUrl = mappedUrls.some(m => m.category === "team");

    // If no team URLs found heuristically but we need people data, try:
    // 1. Generate candidate team page URLs
    // 2. Use LLM-assisted mapping for ambiguous navigation
    const scrapeProfile = getProfile();
    const peoplePat = new RegExp(scrapeProfile.peopleFieldPattern, "i");
    const needsPeopleData = sections.some(s => peoplePat.test(s.key + " " + s.label));
    const peopleConfident = needsPeopleData && sections
      .filter(s => peoplePat.test(s.key + " " + s.label))
      .every(s => (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD);

    if (needsPeopleData && !peopleConfident) {
      if (!hasTeamUrl) {
        // Inject candidate team page URLs
        const teamCandidates = generateTeamPageCandidates(url)
          .filter(u => !visitedUrls.has(u) && !availableLinks.includes(u));
        if (teamCandidates.length > 0) {
          availableLinks = [...teamCandidates, ...availableLinks];
          console.log(`[agentScraper] 🗺️ Map phase: injected ${teamCandidates.length} team page candidates`);
        }

        // If still no clear team URL, use LLM-assisted mapping (cheap, gpt-5-nano)
        if (availableLinks.length > 5) {
          try {
            const llmMapped = await mapUrlsWithLLM(availableLinks, url, sections, companyName);
            const teamFromLLM = llmMapped.filter(m => m.category === "team" || m.category === "about");
            if (teamFromLLM.length > 0) {
              const newUrls = teamFromLLM
                .map(m => m.url)
                .filter(u => !visitedUrls.has(u) && !availableLinks.includes(u));
              availableLinks = [...newUrls, ...availableLinks];
              console.log(`[agentScraper] 🗺️ Map phase (LLM): identified ${teamFromLLM.length} team/about pages`);
            }
          } catch { /* Non-fatal — fall back to regular agent loop */ }
        }
      } else {
        // Re-order available links based on map results (team/about URLs first)
        const prioritized = mappedUrls
          .filter(m => !visitedUrls.has(m.url))
          .sort((a, b) => a.priority - b.priority)
          .map(m => m.url);
        const remaining = availableLinks.filter(u => !prioritized.includes(u));
        availableLinks = [...prioritized, ...remaining];
        console.log(`[agentScraper] 🗺️ Map phase: re-prioritized ${prioritized.length} URLs (team/about first)`);
      }
    }
  }

  // ── AGENT LOOP ─────────────────────────────────────────────────────────────
  while (hopsUsed < maxHops) {
    // Check cancellation at the top of every loop iteration
    if (isCancelled?.()) throw new Error("JOB_CANCELLED");

    // PLAN — decide what to do next
    const plan = await planNextAction(
      companyName,
      url,
      objective,
      sections,
      fieldResults,
      visitedUrls,
      availableLinks,
      hopsUsed,
      maxHops,
      skillContext,
      webSearchedFields,
      failedDomains,
    );

    console.log(`[agentScraper] PLAN [hop ${hopsUsed}/${maxHops}]: ${plan.action} — ${plan.reason}`);

    if (plan.action === "done") break;

    // ACT
    if (plan.action === "fetch_url") {
      if (isCancelled?.()) throw new Error("JOB_CANCELLED");

      const fetched = await fetchAndExtract(plan.target);

      if (!fetched) {
        console.warn(`[agentScraper] ⚠️ fetch_url failed: ${plan.target} — not counting as hop`);
        availableLinks = availableLinks.filter(l => l !== plan.target);
        // Track failed domain for intelligence
        try {
          const failedHost = new URL(plan.target).hostname;
          failedDomains.set(failedHost, (failedDomains.get(failedHost) ?? 0) + 1);
        } catch { /* ignore invalid URL */ }
        continue; // Don't increment hopsUsed — failed fetches shouldn't waste hops
      }
      hopsUsed++;

      visitedUrls.add(plan.target);
      availableLinks = [...new Set([...availableLinks, ...fetched.links])].filter(l => !visitedUrls.has(l));

      // Run specialized page callback before generic extraction
      let skipGenericForFetch = false;
      if (callbacks?.onPageFetched) {
        if (isCancelled?.()) throw new Error("JOB_CANCELLED");
        const cbResult = await callbacks.onPageFetched(plan.target, fetched.content);
        if (cbResult) {
          extras[plan.target] = cbResult.data;
          skipGenericForFetch = cbResult.skipGenericExtraction ?? false;
        }
      }

      // OBSERVE
      if (!skipGenericForFetch) {
        if (isCancelled?.()) throw new Error("JOB_CANCELLED");
        const fetchPageType = isDirectoryUrl(plan.target) ? "directory" : "company";
        const extracted = await extractProfileFields(fetched.content, sections, systemPrompt, plan.target, fetchPageType, skillContext, fetched.rawHtml);

        // REFLECT — merge, keeping higher-confidence values
        fieldResults = mergeFieldResults(fieldResults, extracted);
        const filled = sections.filter(s => (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD).length;
        console.log(`[agentScraper] After fetch_url: ${filled}/${sections.length} fields confident`);
      }

    } else if (plan.action === "web_search") {
      if (isCancelled?.()) throw new Error("JOB_CANCELLED");

      console.log(`[agentScraper] 🔍 Web search: "${plan.query}"`);
      const searchResults = await webSearch(plan.query, 5);

      if (searchResults.length === 0) {
        console.warn(`[agentScraper] Web search returned no results — not counting as hop`);
        continue; // Don't increment hopsUsed — empty searches shouldn't waste hops
      }
      hopsUsed++;

      // Fetch the top-3 unvisited search results (not just top-1) so a single
      // bad/blocked page doesn't waste the entire hop.
      const candidateResults = searchResults.filter(r => !visitedUrls.has(r.url)).slice(0, 3);
      if (candidateResults.length === 0) continue;

      for (const result of candidateResults) {
        if (isCancelled?.()) throw new Error("JOB_CANCELLED");
        const fetched = await fetchAndExtract(result.url, isCancelled);
        if (!fetched) {
          // Use snippet as fallback content for this result
          const snippetContent = `${result.title}\n${result.snippet}`;
          visitedUrls.add(result.url);
          const extracted = await extractProfileFields(snippetContent, sections, systemPrompt, result.url, "search", skillContext);
          fieldResults = mergeFieldResults(fieldResults, extracted);
        } else {
          visitedUrls.add(result.url);
          availableLinks = [...new Set([...availableLinks, ...fetched.links])].filter(l => !visitedUrls.has(l));
          if (isCancelled?.()) throw new Error("JOB_CANCELLED");
          const searchPageType = isDirectoryUrl(result.url) ? "directory" : "company";
          const extracted = await extractProfileFields(fetched.content, sections, systemPrompt, result.url, searchPageType, skillContext, fetched.rawHtml);
          fieldResults = mergeFieldResults(fieldResults, extracted);
        }
        // Stop fetching more results if all target fields are now confident
        const stillWeak = sections.filter(s => (fieldResults[s.key]?.confidence ?? 0) < CONFIDENCE_THRESHOLD);
        if (stillWeak.length === 0) break;
      }

      const filled = sections.filter(s => (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD).length;
      console.log(`[agentScraper] After web_search: ${filled}/${sections.length} fields confident`);

      // Only blacklist the specific field the planner searched for — not ALL weak fields.
      // Blacklisting all weak fields causes premature 'done' on fields that haven't
      // been searched yet and might still be found by navigating internal pages.
      if ((plan as any).targetField) {
        webSearchedFields.add((plan as any).targetField);
      } else {
        // Fallback: blacklist the single weakest field that triggered this search
        const weakestField = sections
          .filter(s => (fieldResults[s.key]?.confidence ?? 0) < CONFIDENCE_THRESHOLD)
          .sort((a, b) => (fieldResults[a.key]?.confidence ?? 0) - (fieldResults[b.key]?.confidence ?? 0))[0];
        if (weakestField) webSearchedFields.add(weakestField.key);
      }
    }
  }

  // ── POST-LOOP ENRICHMENT CASCADE ─────────────────────────────────────────
  //
  //  Order (cheapest / highest-coverage first):
  //    1. Hunter Domain Search  — emails + names from Hunter's index (~$0.01/call)
  //    2. Apify LinkedIn — DM name/title when Hunter had no coverage (~$0.008/profile)
  //    3. SMTP handshake — generic email fallback (free, last resort)
  //
  //  Each step is independently gated and non-fatal.

  const _domain = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } })();

  // ── Step 1: Hunter Domain Search ─────────────────────────────────────────
  if (!isCancelled?.()) {
    try {
      const hunterResult = await hunterDomainSearch(_domain, sections, fieldResults);
      if (hunterResult.bestMatch) {
        const hm = hunterResult.bestMatch;
        const sourceUrl = `https://hunter.io/domain-search?domain=${_domain}`;
        // Merge name, title, email, linkedin into weak DM fields
        for (const s of sections) {
          const kl = s.key.toLowerCase();
          const isDm = /decision.?maker|dm\d|contact|person/.test(kl);
          if (isDm && /name/.test(kl) && !fieldResults[s.key]?.value && hm.firstName) {
            fieldResults[s.key] = {
              value: `${hm.firstName} ${hm.lastName}`.trim(),
              confidence: 0.82,
              sourceUrl,
            };
          } else if (isDm && /title|role|position/.test(kl) && !fieldResults[s.key]?.value && hm.position) {
            fieldResults[s.key] = { value: hm.position, confidence: 0.82, sourceUrl };
          } else if (/email/i.test(kl) && !fieldResults[s.key]?.value && hm.value) {
            fieldResults[s.key] = {
              value: hm.value,
              confidence: Math.min(0.95, hm.confidence / 100),
              sourceUrl,
            };
          } else if (isDm && /linkedin/.test(kl) && !fieldResults[s.key]?.value && hm.linkedinUrl) {
            fieldResults[s.key] = { value: hm.linkedinUrl, confidence: 0.88, sourceUrl: hm.linkedinUrl };
          }
        }
        extras["__hunterEmails"] = hunterResult.allEmails;
        console.log(
          `[agentScraper] Hunter Domain Search merged: ${hm.firstName} ${hm.lastName} <${hm.value}> (${hm.position || hm.seniority || "?"})`,
        );
      } else if (hunterResult.skippedReason) {
        console.log(`[agentScraper] Hunter Domain Search skipped: ${hunterResult.skippedReason}`);
      }
    } catch (err) {
      console.warn(`[agentScraper] Hunter Domain Search failed (non-fatal):`, err);
    }
  }

  // ── Step 2: Apify LinkedIn ──────────────────────────────────────────────
  // Only runs if Hunter had no DM name coverage (saves Apify credits).
  if (!isCancelled?.()) {
    try {
      const targetTitles = skillContext?.targetTitles ?? [];
      const linkedInResult = await enrichWithLinkedIn(
        _domain,
        companyName,
        sections,
        fieldResults,
        companyLinkedinUrl,
        targetTitles,
      );
      if (linkedInResult.bestMatch) {
        const bm = linkedInResult.bestMatch;
        // Merge best match into weak DM name/title/linkedin fields
        for (const s of sections) {
          const keyLower = s.key.toLowerCase();
          const isDmField = /decision.?maker|dm\d|contact|person/.test(keyLower);
          if (isDmField && /name/.test(keyLower) && !fieldResults[s.key]?.value) {
            fieldResults[s.key] = { value: bm.name, confidence: 0.85, sourceUrl: bm.linkedinUrl || url };
          } else if (isDmField && /title|role|position/.test(keyLower) && !fieldResults[s.key]?.value) {
            fieldResults[s.key] = { value: bm.title, confidence: 0.85, sourceUrl: bm.linkedinUrl || url };
          } else if (isDmField && /linkedin/.test(keyLower) && !fieldResults[s.key]?.value && bm.linkedinUrl) {
            fieldResults[s.key] = { value: bm.linkedinUrl, confidence: 0.9, sourceUrl: bm.linkedinUrl };
          }
        }
        // Store all candidates in extras for the Sources sheet
        extras["__linkedInCandidates"] = linkedInResult.allCandidates;
        extras["__linkedInCompanyUrl"] = linkedInResult.linkedInCompanyUrl;
        console.log(`[agentScraper] LinkedIn enrichment merged: ${bm.name} (${bm.title})`);
      } else if (linkedInResult.skippedReason) {
        console.log(`[agentScraper] LinkedIn enrichment skipped: ${linkedInResult.skippedReason}`);
      }
    } catch (err) {
      console.warn(`[agentScraper] LinkedIn enrichment failed (non-fatal):`, err);
    }
  }

  // ── Step 3: SMTP Generic Email Fallback ──────────────────────────────────
  // Free last-resort: knock on the mail server to verify generic addresses.
  // Only fires when ALL email fields are still empty after the above steps.
  if (!isCancelled?.() && shouldRunSmtpFallback(sections, fieldResults)) {
    try {
      const smtpResult = await smtpVerifyGenericEmail(_domain);
      if (smtpResult) {
        const sourceUrl = `smtp://${smtpResult.mxHost}:${smtpResult.port}`;
        for (const s of sections) {
          if (/email/i.test(s.key + " " + s.label) && !fieldResults[s.key]?.value) {
            fieldResults[s.key] = {
              value: smtpResult.email,
              // Catch-all addresses are less reliable — lower confidence
              confidence: smtpResult.catchAll ? 0.55 : 0.75,
              sourceUrl,
            };
          }
        }
        console.log(
          `[agentScraper] SMTP fallback: ${smtpResult.email}` +
          (smtpResult.catchAll ? " (catch-all domain)" : " (verified)"),
        );
      } else {
        console.log(`[agentScraper] SMTP fallback: no generic email found for ${_domain}`);
      }
    } catch (err) {
      console.warn(`[agentScraper] SMTP fallback failed (non-fatal):`, err);
    }
  }

  // ── BUILD FINAL RESULT ─────────────────────────────────────────────────────
  // Flatten fieldResults into plain data map (backward compatible)
  const data: Record<string, string> = {};
  for (const s of sections) {
    data[s.key] = fieldResults[s.key]?.value ?? "";
  }

  const emptyFields = sections.map(s => s.key).filter(k => !data[k] || data[k].trim() === "");
  const stats: ScrapeStats = {
    fieldsTotal: sections.length,
    fieldsFilled: sections.length - emptyFields.length,
    emptyFields,
  };

  const filledCount = sections.filter(s => (fieldResults[s.key]?.confidence ?? 0) >= CONFIDENCE_THRESHOLD).length;
  console.log(
    `[agentScraper] ✅ Done: ${visitedUrls.size} pages visited, ` +
    `${filledCount}/${sections.length} fields confident, ` +
    `${stats.fieldsFilled}/${sections.length} fields non-empty`
  );

  return {
    type: "profile",
    data,
    fieldResults,
    stats,
    ...(Object.keys(extras).length > 0 ? { extras } : {}),
  };
}

// ---------------------------------------------------------------------------
// 7. Directory scraping — preserved as opt-in for "Collected URLs" tab
// ---------------------------------------------------------------------------

/**
 * Scrape a URL as a directory (listing page).
 * Only used when the user explicitly provides a directory URL in their input.
 * This is NOT called automatically during profile enrichment.
 */
export async function scrapeUrlAsDirectory(
  url: string,
  objective: string,
): Promise<AgentScrapeResult> {
  console.log(`[agentScraper] Directory mode: ${url}`);

  const KNOWN_DIRECTORIES = ['goodfirms.co', 'clutch.co', 'g2.com', 'yelp.com', 'capterra.com', 'trustpilot.com'];
  const urlHost = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  const isKnownDir = KNOWN_DIRECTORIES.some(d => urlHost.includes(d));

  // Fetch and do a quick LLM check to confirm it's actually a directory
  const fetched = await fetchAndExtract(url);
  if (!fetched) {
    return { type: "directory", entries: [] };
  }

  // Quick heuristic: if it's a known directory domain, trust it
  // Otherwise, do a fast LLM check
  let isDirectory = isKnownDir;
  if (!isKnownDir) {
    try {
      const checkPrompt = `Is this page a listing/directory of multiple companies or entities, or is it a single company's own website?
URL: ${url}
Content (first 3000 chars): ${fetched.content.substring(0, 3000)}
Return ONLY: {"isDirectory":true|false}`;
      const resp = await queuedLLMCall({
        messages: [{ role: "user", content: checkPrompt }],
        response_format: { type: "json_schema", json_schema: { name: "dir_check", strict: true, schema: { type: "object", properties: { isDirectory: { type: "boolean" } }, required: ["isDirectory"], additionalProperties: false } } },
      });
      const raw = resp.choices[0]?.message?.content ?? "{}";
      isDirectory = JSON.parse(typeof raw === "string" ? raw : "{}").isDirectory ?? false;
    } catch { isDirectory = false; }
  }

  if (!isDirectory) {
    console.log(`[agentScraper] URL is not a directory — use scrapeUrl() for profile enrichment`);
    return { type: "directory", entries: [] };
  }

  const dirResult = await extractDirectory(url, {
    entryLabel: objective || "entities",
    maxPages: 500,
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
