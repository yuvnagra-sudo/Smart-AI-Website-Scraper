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
    const members = await extractTeamMembersFromText(fullText, companyName, resolvedProfile);
    console.log(`[comprehensiveTeamExtraction] Extracted ${members.length} members in single pass`);
    return members;
  }

  // For large pages, use chunking strategy
  const numChunks = Math.ceil(fullText.length / 15000);
  console.log(`[comprehensiveTeamExtraction] Large page, using ${numChunks} chunks`);
  onProgress?.(`Extracting ${resolvedProfile.peopleLabel} (large page: ${numChunks} chunks)...`);

  const allMembers: TeamMemberRaw[] = [];
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
