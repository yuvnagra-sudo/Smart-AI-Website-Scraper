/**
 * Comprehensive Team Member Extraction
 * Handles large team pages with chunking and multi-page support
 */

import * as cheerio from "cheerio";
// Removed: import { invokeLLM } from "./_core/llm"; - Now using OpenAI only via llmQueue
import { queuedLLMCall } from "./_core/llmQueue";
import { type ScrapeProfile, VC_PROFILE } from "./scrapeProfile";

interface TeamMemberRaw {
  name: string;
  title: string;
  job_function: string;
  specialization: string;
}

// ---------------------------------------------------------------------------
// Pre-LLM structured extraction helpers
// ---------------------------------------------------------------------------

const TITLE_KEYWORDS = /\b(ceo|cto|cfo|coo|cmo|cpo|ciso|founder|partner|president|director|head|manager|lead|analyst|associate|vp|vice president|officer|principal)\b/i;

/**
 * Extract people from JSON-LD structured data (<script type="application/ld+json">).
 * Looks for @type "Person" and Organization.employee arrays.
 * Returns results at confidence 0.95 — no LLM needed for these.
 */
function extractPeopleFromStructuredData(html: string): TeamMemberRaw[] {
  const results: TeamMemberRaw[] = [];
  const $ = cheerio.load(html);

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html() ?? "";
      const data = JSON.parse(raw) as Record<string, unknown>;
      const items: unknown[] = Array.isArray(data) ? data : [data];

      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;

        // Direct @type: Person
        if (obj["@type"] === "Person") {
          const name = (obj.name as string | undefined)?.trim();
          const title = (obj.jobTitle as string | undefined)?.trim() ?? "";
          if (name && name.length > 1) {
            results.push({ name, title, job_function: "", specialization: "" });
          }
        }

        // Organization.employee[]
        const employees = obj.employee ?? obj.member ?? obj.founders;
        const list = Array.isArray(employees) ? employees : employees ? [employees] : [];
        for (const emp of list) {
          if (!emp || typeof emp !== "object") continue;
          const e = emp as Record<string, unknown>;
          if (e["@type"] !== "Person" && e["@type"] !== "OrganizationRole") continue;
          const name = (e.name as string | undefined)?.trim();
          const title = (e.jobTitle as string | undefined)?.trim() ?? "";
          if (name && name.length > 1) {
            results.push({ name, title, job_function: "", specialization: "" });
          }
        }
      }
    } catch {
      // Malformed JSON-LD — skip
    }
  });

  // Also check microdata [itemtype*="schema.org/Person"]
  $("[itemtype*='schema.org/Person']").each((_, el) => {
    const name = $(el).find("[itemprop='name']").first().text().trim();
    const title = $(el).find("[itemprop='jobTitle']").first().text().trim();
    if (name && name.length > 1) {
      results.push({ name, title, job_function: "", specialization: "" });
    }
  });

  if (results.length > 0) {
    console.log(`[structuredData] Extracted ${results.length} people from JSON-LD/microdata`);
  }

  return results;
}

/**
 * Extract people from common CSS patterns used by team/staff pages.
 * Tries well-known card selectors first, then falls back to a heading-pair heuristic.
 * Returns results at confidence 0.85 (cards) / 0.75 (heading-pair).
 */
function extractPeopleFromCSSPatterns(html: string): TeamMemberRaw[] {
  const results: TeamMemberRaw[] = [];
  const $ = cheerio.load(html);

  const CARD_SELECTORS = [
    ".team-member", ".team-card", ".staff-member", ".person-card",
    "[class*='team-member']", "[class*='team-card']", "[class*='TeamMember']",
    "[data-team-member]", "[data-person]",
  ];

  const NAME_SELECTORS = ["h2", "h3", "h4", ".name", ".person-name", ".member-name", "[class*='name']"];
  const TITLE_SELECTORS = [".title", ".role", ".position", ".job-title", "[class*='title']", "[class*='role']", "[class*='position']"];

  let cardHits = 0;
  for (const selector of CARD_SELECTORS) {
    $(selector).each((_, card) => {
      let name = "";
      let title = "";

      for (const ns of NAME_SELECTORS) {
        const text = $(card).find(ns).first().text().trim();
        if (text && text.length > 1 && text.length < 80 && /^[A-Z]/.test(text)) {
          name = text;
          break;
        }
      }

      for (const ts of TITLE_SELECTORS) {
        const text = $(card).find(ts).first().text().trim();
        if (text && text.length > 1 && text.length < 120) {
          title = text;
          break;
        }
      }

      if (name) {
        results.push({ name, title, job_function: "", specialization: "" });
        cardHits++;
      }
    });
    if (cardHits > 0) break; // First matching selector wins
  }

  if (cardHits === 0) {
    // Fallback: heading-pair heuristic — h3/h4 proper-case text followed by sibling p with title keywords
    $("h3, h4").each((_, heading) => {
      const nameText = $(heading).text().trim();
      if (!nameText || nameText.length < 3 || nameText.length > 60) return;
      if (!/^[A-Z][a-z]/.test(nameText)) return; // Must look like a proper name

      const sibling = $(heading).next("p, .title, .role, .position, span").first();
      const titleText = sibling.text().trim();

      if (titleText && TITLE_KEYWORDS.test(titleText)) {
        results.push({ name: nameText, title: titleText, job_function: "", specialization: "" });
      }
    });
  }

  if (results.length > 0) {
    console.log(`[cssPatterns] Extracted ${results.length} people from CSS patterns`);
  }

  return results;
}

/**
 * Deduplicate a list of TeamMemberRaw by normalized name.
 */
function deduplicateByName(members: TeamMemberRaw[]): TeamMemberRaw[] {
  const seen = new Set<string>();
  return members.filter((m) => {
    const key = m.name.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------

/**
 * Extract team members from HTML with chunking for large pages
 */
export async function extractTeamMembersComprehensive(
  html: string,
  companyName: string,
  onProgress?: (message: string) => void,
  profile?: ScrapeProfile,
): Promise<TeamMemberRaw[]> {
  const resolvedProfile = profile ?? VC_PROFILE;
  console.log(`[comprehensiveTeamExtraction] Starting extraction for ${companyName}`);
  console.log(`[comprehensiveTeamExtraction] HTML length: ${html.length} chars`);

  // --- Pre-LLM pass 1: JSON-LD / microdata structured data ---
  const structuredPeople = extractPeopleFromStructuredData(html);

  // --- Pre-LLM pass 2: CSS card / heading-pair patterns ---
  const cssPeople = extractPeopleFromCSSPatterns(html);

  // Combine pre-LLM results (deduplicated)
  const preLLMPeople = deduplicateByName([...structuredPeople, ...cssPeople]);
  if (preLLMPeople.length > 0) {
    onProgress?.(`Found ${preLLMPeople.length} people from structured data / CSS patterns`);
    console.log(`[comprehensiveTeamExtraction] Pre-LLM found ${preLLMPeople.length} people`);
  }

  const $ = cheerio.load(html);

  // Remove noise elements
  $("script, style, nav, footer, header, .cookie, .banner").remove();

  // Get all text content
  const fullText = $("body").text().replace(/\s+/g, " ").trim();
  console.log(`[comprehensiveTeamExtraction] Extracted text length: ${fullText.length} chars`);

  // If the page is small enough, process it all at once
  if (fullText.length <= 15000) {
    console.log(`[comprehensiveTeamExtraction] Small page, single pass`);
    onProgress?.(`Extracting ${resolvedProfile.peopleLabel} (single pass)...`);
    const llmMembers = await extractTeamMembersFromText(fullText, companyName, resolvedProfile);
    console.log(`[comprehensiveTeamExtraction] Extracted ${llmMembers.length} members in single pass`);
    const merged = deduplicateByName([...preLLMPeople, ...llmMembers]);
    console.log(`[comprehensiveTeamExtraction] Merged total: ${merged.length} members`);
    return merged;
  }

  // For large pages, use chunking strategy
  const numChunks = Math.ceil(fullText.length / 15000);
  console.log(`[comprehensiveTeamExtraction] Large page, using ${numChunks} chunks`);
  onProgress?.(`Extracting ${resolvedProfile.peopleLabel} (large page: ${numChunks} chunks)...`);

  const allMembers: TeamMemberRaw[] = [...preLLMPeople];
  const CHUNK_SIZE = 15000;
  const OVERLAP = 500; // Overlap to avoid cutting names in half

  for (let i = 0; i < fullText.length; i += (CHUNK_SIZE - OVERLAP)) {
    const chunk = fullText.substring(i, i + CHUNK_SIZE);

    if (chunk.trim().length < 100) continue; // Skip tiny chunks

    const chunkMembers = await extractTeamMembersFromText(chunk, companyName, resolvedProfile);

    // Deduplicate by name (case-insensitive)
    for (const member of chunkMembers) {
      const exists = allMembers.find(
        m => m.name.toLowerCase() === member.name.toLowerCase()
      );

      if (!exists) {
        allMembers.push(member);
      }
    }

    onProgress?.(`Found ${allMembers.length} team members so far...`);
  }

  console.log(`[comprehensiveTeamExtraction] Total extracted: ${allMembers.length} members`);
  return allMembers;
}

/**
 * Extract team members from a text chunk using LLM
 */
async function extractTeamMembersFromText(
  text: string,
  companyName: string,
  profile: ScrapeProfile,
): Promise<TeamMemberRaw[]> {
  console.log(`[extractTeamMembersFromText] Processing ${text.length} chars for ${companyName}`);

  const functionCategories = profile.peopleFunctionCategories.join(", ");
  const specializationLine = profile.peopleSpecializationHint
    ? `4. ${profile.categoriesLabel} specialization (${profile.peopleSpecializationHint})`
    : `4. Area of specialization (if mentioned, otherwise leave empty)`;

  const prompt = `You are analyzing a ${profile.organizationLabel}'s team page to extract information about ${profile.peopleLabel}.

Company: ${companyName}

Page Content:
${text}

Extract information about each ${profile.peopleSingular}. For each person, provide:
1. Full name
2. Job title (exactly as written on the page)
3. Main job function (categorize as one of: ${functionCategories}, or Other)
${specializationLine}

Return the results as a JSON object with a "team_members" key containing an array of objects.

Example format:
{
  "team_members": [
    {"name": "John Doe", "title": "Managing Partner", "job_function": "Partner", "specialization": "FinTech"},
    {"name": "Jane Smith", "title": "Investment Associate", "job_function": "Associate", "specialization": ""}
  ]
}`;

  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "team_members",
          strict: true,
          schema: {
            type: "object",
            properties: {
              team_members: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    title: { type: "string" },
                    job_function: { type: "string" },
                    specialization: { type: "string" },
                  },
                  required: ["name", "title", "job_function", "specialization"],
                  additionalProperties: false,
                },
              },
            },
            required: ["team_members"],
            additionalProperties: false,
          },
        },
      },
    });

    console.log(`[extractTeamMembersFromText] LLM response received`);
    const rawContent = response.choices[0]?.message?.content;
    const content = typeof rawContent === 'string' ? rawContent : '';
    console.log(`[extractTeamMembersFromText] Content length: ${content.length}`);
    console.log(`[extractTeamMembersFromText] First 300 chars: ${content.substring(0, 300)}`);
    
    const result = JSON.parse(typeof content === 'string' ? content : '{}');
    const members = result.team_members || [];
    console.log(`[extractTeamMembersFromText] Parsed ${members.length} members from JSON`);
    
    if (members.length === 0) {
      console.warn(`[extractTeamMembersFromText] ⚠️ WARNING: 0 members extracted!`);
      console.warn(`[extractTeamMembersFromText] Input text sample (first 500 chars): ${text.substring(0, 500)}`);
      console.warn(`[extractTeamMembersFromText] LLM response: ${content}`);
    }
    
    if (members.length > 0) {
      console.log(`[extractTeamMembersFromText] Sample titles:`);
      members.slice(0, 3).forEach((m: any) => {
        console.log(`  - ${m.name}: "${m.title}"`);
      });
    }
    return members;
  } catch (error) {
    console.error("[extractTeamMembersFromText] Error:", error);
    return [];
  }
}

/**
 * Check for pagination or "Load More" buttons and extract additional pages
 */
export async function detectAndFetchAdditionalTeamPages(
  html: string,
  baseUrl: string
): Promise<string[]> {
  const $ = cheerio.load(html);
  const additionalUrls: string[] = [];
  
  // Look for pagination links
  $('a[href*="page"], a[href*="team"], button[class*="load"], button[class*="more"]').each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().toLowerCase();
    
    // Check if it's a pagination or load more link
    if (href && (
      text.includes("next") ||
      text.includes("more") ||
      text.includes("page") ||
      /page=\d+/.test(href) ||
      /\/\d+$/.test(href)
    )) {
      // Convert relative URLs to absolute
      const absoluteUrl = href.startsWith("http") 
        ? href 
        : new URL(href, baseUrl).toString();
      
      if (!additionalUrls.includes(absoluteUrl)) {
        additionalUrls.push(absoluteUrl);
      }
    }
  });
  
  // Return all pagination URLs (no limit)
  return additionalUrls;
}
