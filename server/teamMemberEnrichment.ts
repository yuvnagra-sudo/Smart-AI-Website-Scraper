/**
 * Team Member Specialization Waterfall Enrichment
 * 
 * Multi-source enrichment strategy for team member specialization:
 * 1. LinkedIn profile (most accurate)
 * 2. Team member bio on VC website
 * 3. Recent portfolio companies (infer from investments)
 * 4. Cross-validation across sources
 */

// Removed: import { invokeLLM } from "./_core/llm"; - Now using OpenAI only via llmQueue
import { queuedLLMCall } from "./_core/llmQueue";
import { scrapeLinkedInProfile } from "./linkedinMatcher";
import { formatNichesForPrompt } from "./nicheTaxonomy";
import * as cheerio from "cheerio";

interface SpecializationSource {
  source: string;
  niches: string[];
  confidence: "High" | "Medium" | "Low";
  rawData: string;
}

interface EnrichedSpecialization {
  finalNiches: string[];
  confidence: "High" | "Medium" | "Low";
  sources: SpecializationSource[];
  crossValidated: boolean;
}

/**
 * Extract specialization from LinkedIn profile
 */
async function getSpecializationFromLinkedIn(
  linkedinUrl: string
): Promise<SpecializationSource | null> {
  if (!linkedinUrl) return null;
  
  const profileData = await scrapeLinkedInProfile(linkedinUrl);
  if (!profileData) return null;
  
  const rawData = `${profileData.headline}\n${profileData.about}`;
  
  // Use AI to map LinkedIn data to our niche taxonomy
  const nicheTaxonomy = formatNichesForPrompt();
  
  const prompt = `You are analyzing a VC team member's LinkedIn profile to identify their investment specialization.

LinkedIn Headline: ${profileData.headline}
LinkedIn About: ${profileData.about}

Based on this information, identify which investment niches this person specializes in. Use ONLY the niches from this predefined taxonomy:

${nicheTaxonomy}

You can select multiple niches. Return your answer as a JSON object with a "niches" key containing an array of niche names exactly as they appear in the taxonomy.

Example format:
{"niches": ["FinTech", "SaaS", "B2B Software"]}

If you cannot determine specialization, return: {"niches": []}`;

  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "specialization",
          strict: true,
          schema: {
            type: "object",
            properties: {
              niches: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["niches"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    const result = JSON.parse(typeof content === 'string' ? content : '{}');
    const niches = result.niches || [];

    return {
      source: "LinkedIn Profile",
      niches,
      confidence: niches.length > 0 ? "High" : "Low",
      rawData,
    };
  } catch (error) {
    console.error("Error extracting specialization from LinkedIn:", error);
    return null;
  }
}

/**
 * Extract specialization from team member bio on website
 */
async function getSpecializationFromBio(
  memberName: string,
  teamPageHtml: string
): Promise<SpecializationSource | null> {
  const $ = cheerio.load(teamPageHtml);
  
  // Find the team member's section/card
  let bioText = "";
  
  // Strategy 1: Find by name in heading/title
  $("h1, h2, h3, h4, h5, h6, .name, .team-member-name").each((_, el) => {
    const text = $(el).text();
    if (text.toLowerCase().includes(memberName.toLowerCase())) {
      // Get the parent container and extract bio
      const container = $(el).closest("div, section, article");
      bioText = container.text();
      return false; // break
    }
  });
  
  if (!bioText) return null;
  
  // Use AI to extract specialization from bio
  const nicheTaxonomy = formatNichesForPrompt();
  
  const prompt = `You are analyzing a VC team member's biography to identify their investment specialization.

Team Member: ${memberName}
Bio:
${bioText}

Based on this biography, identify which investment niches this person specializes in. Use ONLY the niches from this predefined taxonomy:

${nicheTaxonomy}

You can select multiple niches. Return your answer as a JSON object with a "niches" key containing an array of niche names exactly as they appear in the taxonomy.

Example format:
{"niches": ["Healthcare", "Biotech"]}

If you cannot determine specialization, return: {"niches": []}`;

  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "specialization",
          strict: true,
          schema: {
            type: "object",
            properties: {
              niches: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["niches"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    const result = JSON.parse(typeof content === 'string' ? content : '{}');
    const niches = result.niches || [];

    return {
      source: "Team Member Bio",
      niches,
      confidence: niches.length > 0 ? "Medium" : "Low",
      rawData: bioText.substring(0, 500),
    };
  } catch (error) {
    console.error("Error extracting specialization from bio:", error);
    return null;
  }
}

/**
 * Infer specialization from portfolio companies the team member led
 */
async function getSpecializationFromPortfolio(
  memberName: string,
  portfolioPageHtml: string
): Promise<SpecializationSource | null> {
  const $ = cheerio.load(portfolioPageHtml);
  
  // Look for mentions of the team member in portfolio descriptions
  let relevantCompanies: string[] = [];
  
  $("div, section, article").each((_, el) => {
    const text = $(el).text();
    if (text.toLowerCase().includes(memberName.toLowerCase()) && 
        (text.toLowerCase().includes("led") || text.toLowerCase().includes("investment"))) {
      relevantCompanies.push(text);
    }
  });
  
  if (relevantCompanies.length === 0) return null;
  
  const combinedText = relevantCompanies.join("\n\n");
  const nicheTaxonomy = formatNichesForPrompt();
  
  const prompt = `You are analyzing portfolio companies that a VC team member has invested in or led to infer their specialization.

Team Member: ${memberName}
Portfolio Information:
${combinedText}

Based on the companies this person has invested in, identify which investment niches they specialize in. Use ONLY the niches from this predefined taxonomy:

${nicheTaxonomy}

You can select multiple niches. Return your answer as a JSON object with a "niches" key containing an array of niche names exactly as they appear in the taxonomy.

Example format:
{"niches": ["Enterprise Software", "SaaS"]}

If you cannot determine specialization, return: {"niches": []}`;

  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "specialization",
          strict: true,
          schema: {
            type: "object",
            properties: {
              niches: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["niches"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    const result = JSON.parse(typeof content === 'string' ? content : '{}');
    const niches = result.niches || [];

    return {
      source: "Portfolio Companies",
      niches,
      confidence: niches.length > 0 ? "Medium" : "Low",
      rawData: combinedText.substring(0, 500),
    };
  } catch (error) {
    console.error("Error inferring specialization from portfolio:", error);
    return null;
  }
}

/**
 * Cross-validate specialization across multiple sources
 */
function crossValidateSpecialization(
  sources: SpecializationSource[]
): EnrichedSpecialization {
  if (sources.length === 0) {
    return {
      finalNiches: [],
      confidence: "Low",
      sources: [],
      crossValidated: false,
    };
  }
  
  // Count occurrences of each niche across sources
  const nicheCount = new Map<string, number>();
  const nicheSourceCount = new Map<string, Set<string>>();
  
  sources.forEach(source => {
    source.niches.forEach(niche => {
      nicheCount.set(niche, (nicheCount.get(niche) || 0) + 1);
      
      if (!nicheSourceCount.has(niche)) {
        nicheSourceCount.set(niche, new Set());
      }
      nicheSourceCount.get(niche)!.add(source.source);
    });
  });
  
  // Niches that appear in multiple sources are high confidence
  const crossValidatedNiches = Array.from(nicheCount.entries())
    .filter(([_, count]) => count >= 2)
    .map(([niche]) => niche);
  
  // If we have cross-validated niches, use those
  if (crossValidatedNiches.length > 0) {
    return {
      finalNiches: crossValidatedNiches,
      confidence: "High",
      sources,
      crossValidated: true,
    };
  }
  
  // Otherwise, use niches from the highest confidence source
  const highestConfidenceSource = sources.reduce((best, current) => {
    const confidenceOrder = { "High": 3, "Medium": 2, "Low": 1 };
    return confidenceOrder[current.confidence] > confidenceOrder[best.confidence] 
      ? current 
      : best;
  });
  
  return {
    finalNiches: highestConfidenceSource.niches,
    confidence: highestConfidenceSource.confidence,
    sources,
    crossValidated: false,
  };
}

/**
 * Waterfall enrichment for team member specialization
 */
export async function enrichTeamMemberSpecialization(
  memberName: string,
  linkedinUrl: string,
  teamPageHtml: string,
  portfolioPageHtml: string,
  onProgress?: (message: string) => void
): Promise<EnrichedSpecialization> {
  const sources: SpecializationSource[] = [];
  
  // Source 1: LinkedIn profile (DISABLED - LinkedIn blocks automated requests)
  // LinkedIn returns status 999 "Request denied" for all automated requests
  // Keeping this code for future reference if we get LinkedIn API access
  /*
  if (linkedinUrl) {
    onProgress?.(`Checking LinkedIn profile for ${memberName}...`);
    const linkedinData = await getSpecializationFromLinkedIn(linkedinUrl);
    if (linkedinData) {
      sources.push(linkedinData);
    }
  }
  */
  
  // Source 2: Team member bio
  onProgress?.(`Checking team bio for ${memberName}...`);
  const bioData = await getSpecializationFromBio(memberName, teamPageHtml);
  if (bioData) {
    sources.push(bioData);
  }
  
  // Source 3: Portfolio companies
  if (portfolioPageHtml) {
    onProgress?.(`Checking portfolio for ${memberName}...`);
    const portfolioData = await getSpecializationFromPortfolio(memberName, portfolioPageHtml);
    if (portfolioData) {
      sources.push(portfolioData);
    }
  }
  
  // Cross-validate and return final result
  const result = crossValidateSpecialization(sources);
  
  if (result.crossValidated) {
    onProgress?.(`✓ Cross-validated specialization for ${memberName} from ${sources.length} sources`);
  } else if (result.finalNiches.length > 0) {
    onProgress?.(`Found specialization for ${memberName} from ${sources.length} source(s)`);
  } else {
    onProgress?.(`Could not determine specialization for ${memberName}`);
  }
  
  return result;
}
