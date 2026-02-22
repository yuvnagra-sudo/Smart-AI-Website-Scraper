/**
 * Iterative LLM-Guided Extraction System
 * 
 * Workflow:
 * 1. Scrape homepage with Jina
 * 2. LLM analyzes content and identifies:
 *    - What data was found (team members, portfolio, niches, etc.)
 *    - What data is still missing
 *    - Which URLs to scrape next to fill gaps
 * 3. Scrape suggested URLs
 * 4. Repeat until all data found OR max iterations reached
 * 5. Return aggregated results
 */

import { invokeLLM } from "./_core/openaiLLM";
import { fetchWebsiteContentHybrid } from "./jinaFetcher";
import { formatNichesForPrompt } from "./nicheTaxonomy";
import { formatInvestorTypesForPrompt, formatInvestmentStagesForPrompt } from "./investorTaxonomy";

/**
 * Extraction state tracks what data we have and what's missing
 */
interface ExtractionState {
  // Data found so far
  investorType: string[];
  investmentStages: string[];
  investmentNiches: string[];
  teamMembers: Array<{
    name: string;
    title: string;
    linkedinUrl?: string;
  }>;
  portfolioCompanies: Array<{
    companyName: string;
    websiteUrl?: string;
    investmentNiche?: string[];
  }>;
  
  // Metadata
  scrapedUrls: string[]; // URLs already scraped
  iteration: number;
  complete: boolean;
}

/**
 * LLM decision output
 */
interface LLMDecision {
  // What data is still missing
  missingData: {
    investorType: boolean;
    investmentStages: boolean;
    investmentNiches: boolean;
    teamMembers: boolean; // true if we have <3 members
    portfolioCompanies: boolean; // true if we have <5 companies
  };
  
  // Suggested URLs to scrape next (max 5)
  suggestedUrls: Array<{
    url: string;
    reason: string; // "Team page", "Portfolio page", etc.
    priority: number; // 1-10
  }>;
  
  // Should we continue iterating?
  shouldContinue: boolean;
  reasoning: string;
}

/**
 * Analyze scraped content and decide next actions
 */
async function analyzeScrapeAndDecideNext(
  companyName: string,
  baseUrl: string,
  scrapedContent: string,
  currentState: ExtractionState,
  availableLinks: string[]
): Promise<LLMDecision> {
  const prompt = `You are an AI assistant helping to extract comprehensive data about a VC firm.

**Firm**: ${companyName}
**Website**: ${baseUrl}

**Current Extraction State**:
- Investor Type: ${currentState.investorType.length > 0 ? currentState.investorType.join(", ") : "NOT FOUND"}
- Investment Stages: ${currentState.investmentStages.length > 0 ? currentState.investmentStages.join(", ") : "NOT FOUND"}
- Investment Niches: ${currentState.investmentNiches.length > 0 ? currentState.investmentNiches.join(", ") : "NOT FOUND"}
- Team Members: ${currentState.teamMembers.length} found
- Portfolio Companies: ${currentState.portfolioCompanies.length} found

**Already Scraped URLs**:
${currentState.scrapedUrls.map(url => `- ${url}`).join('\n')}

**Available Links on Current Page**:
${availableLinks.slice(0, 20).map(url => `- ${url}`).join('\n')}

**Your Task**:
1. Analyze what data is still missing or incomplete
2. Suggest which URLs to scrape next to fill gaps (prioritize most important)
3. Decide if we should continue iterating or if we have enough data

**Missing Data Criteria**:
- Investor Type: Missing if empty
- Investment Stages: Missing if empty
- Investment Niches: Missing if empty
- Team Members: Incomplete if <5 members
- Portfolio Companies: Incomplete if <10 companies

**URL Selection Guidelines**:
- Prioritize pages likely to have missing data
- Look for: /team, /people, /portfolio, /investments, /about, /focus, /thesis
- Avoid: /news, /blog, /contact, /careers (unless specifically needed)
- Only suggest URLs from the available links list

Return your analysis in JSON format:
\`\`\`json
{
  "missingData": {
    "investorType": boolean,
    "investmentStages": boolean,
    "investmentNiches": boolean,
    "teamMembers": boolean,
    "portfolioCompanies": boolean
  },
  "suggestedUrls": [
    {
      "url": "full URL",
      "reason": "why this URL will help",
      "priority": 1-10
    }
  ],
  "shouldContinue": boolean,
  "reasoning": "explanation of your decision"
}
\`\`\``;

  try {
    const response = await invokeLLM({
      messages: [
        { role: "system", content: "You are a data extraction strategist. Analyze extraction state and suggest next actions." },
        { role: "user", content: prompt }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "extraction_decision",
          strict: true,
          schema: {
            type: "object",
            properties: {
              missingData: {
                type: "object",
                properties: {
                  investorType: { type: "boolean" },
                  investmentStages: { type: "boolean" },
                  investmentNiches: { type: "boolean" },
                  teamMembers: { type: "boolean" },
                  portfolioCompanies: { type: "boolean" }
                },
                required: ["investorType", "investmentStages", "investmentNiches", "teamMembers", "portfolioCompanies"],
                additionalProperties: false
              },
              suggestedUrls: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    url: { type: "string" },
                    reason: { type: "string" },
                    priority: { type: "number" }
                  },
                  required: ["url", "reason", "priority"],
                  additionalProperties: false
                }
              },
              shouldContinue: { type: "boolean" },
              reasoning: { type: "string" }
            },
            required: ["missingData", "suggestedUrls", "shouldContinue", "reasoning"],
            additionalProperties: false
          }
        }
      }
    });

    const content = response.choices[0].message.content;
    const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
    const decision = JSON.parse(contentStr || "{}");
    return decision as LLMDecision;
  } catch (error) {
    console.error("[Iterative Extraction] LLM decision failed:", error);
    
    // Fallback: stop iteration
    return {
      missingData: {
        investorType: false,
        investmentStages: false,
        investmentNiches: false,
        teamMembers: false,
        portfolioCompanies: false
      },
      suggestedUrls: [],
      shouldContinue: false,
      reasoning: "LLM decision failed, stopping iteration"
    };
  }
}

/**
 * Extract data from scraped content using LLM
 */
async function extractDataFromContent(
  companyName: string,
  content: string,
  currentState: ExtractionState
): Promise<Partial<ExtractionState>> {
  const updates: Partial<ExtractionState> = {};
  
  // Extract investor type if missing
  if (currentState.investorType.length === 0) {
    const investorTypePrompt = `Analyze this content and identify the investor type(s):\n\n${content.slice(0, 5000)}\n\nAvailable types:\n${formatInvestorTypesForPrompt()}\n\nReturn JSON: {"investorTypes": ["type1", "type2"]}`;
    
    try {
      const response = await invokeLLM({
        messages: [
          { role: "system", content: "You are a VC data extraction specialist." },
          { role: "user", content: investorTypePrompt }
        ]
      });
      
      const result = JSON.parse(response.choices[0].message.content as string || "{}");
      if (result.investorTypes && Array.isArray(result.investorTypes)) {
        updates.investorType = result.investorTypes;
      }
    } catch (error) {
      console.error("[Iterative Extraction] Failed to extract investor type:", error);
    }
  }
  
  // Extract team members
  const teamMemberPrompt = `Extract team members from this content:\n\n${content.slice(0, 8000)}\n\nReturn JSON array: [{"name": "...", "title": "...", "linkedinUrl": "..."}]`;
  
  try {
    const response = await invokeLLM({
      messages: [
        { role: "system", content: "You are a team member extraction specialist. Extract all team members with their names, titles, and LinkedIn URLs if available." },
        { role: "user", content: teamMemberPrompt }
      ]
    });
    
    const result = JSON.parse(response.choices[0].message.content as string || "[]");
    if (Array.isArray(result) && result.length > 0) {
      updates.teamMembers = [...(currentState.teamMembers || []), ...result];
    }
  } catch (error) {
    console.error("[Iterative Extraction] Failed to extract team members:", error);
  }
  
  // Extract portfolio companies
  const portfolioPrompt = `Extract portfolio companies from this content:\n\n${content.slice(0, 8000)}\n\nReturn JSON array: [{"companyName": "...", "websiteUrl": "...", "investmentNiche": ["..."]}]`;
  
  try {
    const response = await invokeLLM({
      messages: [
        { role: "system", content: "You are a portfolio extraction specialist. Extract all portfolio companies with their names, websites, and investment niches if available." },
        { role: "user", content: portfolioPrompt }
      ]
    });
    
    const result = JSON.parse(response.choices[0].message.content as string || "[]");
    if (Array.isArray(result) && result.length > 0) {
      updates.portfolioCompanies = [...(currentState.portfolioCompanies || []), ...result];
    }
  } catch (error) {
    console.error("[Iterative Extraction] Failed to extract portfolio companies:", error);
  }
  
  return updates;
}

/**
 * Main iterative extraction function
 */
export async function runIterativeExtraction(
  companyName: string,
  websiteUrl: string,
  options: {
    maxIterations?: number;
    onProgress?: (message: string) => void;
  } = {}
): Promise<ExtractionState> {
  const { maxIterations = 5, onProgress } = options;
  console.log(`[Iterative Extraction] Starting for ${companyName}`);
  onProgress?.(`Starting iterative extraction for ${companyName}`);
  
  // Initialize state
  const state: ExtractionState = {
    investorType: [],
    investmentStages: [],
    investmentNiches: [],
    teamMembers: [],
    portfolioCompanies: [],
    scrapedUrls: [],
    iteration: 0,
    complete: false
  };
  
  let lastDecision: LLMDecision | null = null;
  let availableLinks: string[] = [];
  
  // Iteration loop
  while (state.iteration < maxIterations && !state.complete) {
    state.iteration++;
    console.log(`[Iterative Extraction] Iteration ${state.iteration}/${maxIterations}`);
    onProgress?.(`Iteration ${state.iteration}: Analyzing and scraping...`);
    
    // Determine which URLs to scrape
    let urlsToScrape: string[];
    if (state.iteration === 1) {
      // First iteration: scrape homepage
      urlsToScrape = [websiteUrl];
    } else if (lastDecision && lastDecision.suggestedUrls.length > 0) {
      // Subsequent iterations: use LLM's suggested URLs
      urlsToScrape = lastDecision.suggestedUrls
        .sort((a, b) => b.priority - a.priority) // Sort by priority
        .map(u => u.url); // Scrape ALL suggested URLs
    } else {
      // No suggestions, stop
      console.log(`[Iterative Extraction] No URLs to scrape, stopping`);
      state.complete = true;
      break;
    }
    
    // Scrape all URLs in this iteration
    for (const urlToScrape of urlsToScrape) {
      // Skip if already scraped
      if (state.scrapedUrls.includes(urlToScrape)) {
        console.log(`[Iterative Extraction] Skipping already scraped: ${urlToScrape}`);
        continue;
      }
      
      console.log(`[Iterative Extraction] Scraping: ${urlToScrape}`);
      const scrapeResult = await fetchWebsiteContentHybrid(
        urlToScrape,
        async () => {
          // Puppeteer fallback
          const { ComprehensiveScraper } = await import('./scraper/ComprehensiveScraper');
          const scraper = new ComprehensiveScraper();
          const result = await scraper.scrape({ url: urlToScrape });
          return result.success ? result.html || null : null;
        }
      );
      
      if (!scrapeResult.success || !scrapeResult.content) {
        console.warn(`[Iterative Extraction] Failed to scrape ${urlToScrape}`);
        continue;
      }
      
      state.scrapedUrls.push(urlToScrape);
      
      // Extract data from content
      console.log(`[Iterative Extraction] Extracting data from ${urlToScrape}`);
      const extractedData = await extractDataFromContent(
        companyName,
        scrapeResult.content,
        state
      );
      
      // Merge extracted data into state
      if (extractedData.investorType) {
        state.investorType = Array.from(new Set([...state.investorType, ...extractedData.investorType]));
      }
      if (extractedData.investmentStages) {
        state.investmentStages = Array.from(new Set([...state.investmentStages, ...extractedData.investmentStages]));
      }
      if (extractedData.investmentNiches) {
        state.investmentNiches = Array.from(new Set([...state.investmentNiches, ...extractedData.investmentNiches]));
      }
      if (extractedData.teamMembers) {
        // Deduplicate team members by name
        const existingNames = new Set(state.teamMembers.map(m => m.name.toLowerCase()));
        const newMembers = extractedData.teamMembers.filter(
          m => !existingNames.has(m.name.toLowerCase())
        );
        state.teamMembers = [...state.teamMembers, ...newMembers];
      }
      if (extractedData.portfolioCompanies) {
        // Deduplicate portfolio companies by name
        const existingCompanies = new Set(state.portfolioCompanies.map(c => c.companyName.toLowerCase()));
        const newCompanies = extractedData.portfolioCompanies.filter(
          c => !existingCompanies.has(c.companyName.toLowerCase())
        );
        state.portfolioCompanies = [...state.portfolioCompanies, ...newCompanies];
      }
      
      // Extract available links from content
      const newLinks = extractLinksFromMarkdown(scrapeResult.content, websiteUrl);
      availableLinks = Array.from(new Set([...availableLinks, ...newLinks]));
      
      console.log(`[Iterative Extraction] State after extraction:`);
      console.log(`  - Team members: ${state.teamMembers.length}`);
      console.log(`  - Portfolio companies: ${state.portfolioCompanies.length}`);
      console.log(`  - Available links: ${availableLinks.length}`);
    }
    
    // LLM decides next action
    console.log(`[Iterative Extraction] Asking LLM for next action...`);
    lastDecision = await analyzeScrapeAndDecideNext(
      companyName,
      websiteUrl,
      `Scraped ${state.scrapedUrls.length} pages so far`,
      state,
      availableLinks
    );
    
    console.log(`[Iterative Extraction] LLM Decision:`);
    console.log(`  - Should continue: ${lastDecision.shouldContinue}`);
    console.log(`  - Suggested URLs: ${lastDecision.suggestedUrls.length}`);
    console.log(`  - Reasoning: ${lastDecision.reasoning}`);
    
    if (!lastDecision.shouldContinue) {
      console.log(`[Iterative Extraction] Stopping: ${lastDecision.reasoning}`);
      state.complete = true;
      break;
    }
    
    if (lastDecision.suggestedUrls.length === 0) {
      console.log(`[Iterative Extraction] No more URLs suggested, stopping`);
      state.complete = true;
      break;
    }
  }
  
  console.log(`[Iterative Extraction] Completed after ${state.iteration} iterations`);
  onProgress?.(`Extraction complete after ${state.iteration} iterations`);
  
  return state;
}

/**
 * Extract links from markdown content
 */
function extractLinksFromMarkdown(markdown: string, baseUrl: string): string[] {
  const links: string[] = [];
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  
  while ((match = linkRegex.exec(markdown)) !== null) {
    const url = match[2];
    
    // Convert relative URLs to absolute
    let absoluteUrl: string;
    try {
      absoluteUrl = new URL(url, baseUrl).href;
    } catch {
      continue;
    }
    
    // Only include URLs from same domain
    const baseDomain = new URL(baseUrl).hostname;
    const linkDomain = new URL(absoluteUrl).hostname;
    
    if (linkDomain === baseDomain || linkDomain.endsWith(`.${baseDomain}`)) {
      links.push(absoluteUrl);
    }
  }
  
  return Array.from(new Set(links)); // Remove duplicates
}
