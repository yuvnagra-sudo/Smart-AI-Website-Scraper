/**
 * VC Enrichment Service
 * Handles the extraction and enrichment of VC firm data
 */
import { invokeLLM } from "./_core/llm";
import { queuedLLMCall } from "./_core/llmQueue";
import { aggregateFreeApiData } from "./dataSources/freeApis";
import { formatNichesForPrompt } from "./nicheTaxonomy";
import { formatInvestorTypesForPrompt, formatInvestmentStagesForPrompt } from "./investorTaxonomy";
import { extractAndMatchLinkedInURLs } from "./improvedLinkedInExtractor";
import { findLinkedInURLForPerson } from "./smartUrlConstructor";
import { enrichTeamMemberSpecialization } from "./teamMemberEnrichment";
import { extractTeamMembersComprehensive, detectAndFetchAdditionalTeamPages } from "./comprehensiveTeamExtraction";
import axios from "axios";
import * as cheerio from "cheerio";

interface TeamMember {
  name: string;
  title: string;
  jobFunction: string;
  specialization: string;
  linkedinUrl: string;
  dataSourceUrl: string;
  confidenceScore: string;
}

interface PortfolioCompany {
  companyName: string;
  investmentDate: string;
  websiteUrl: string;
  investmentNiche: string[];
  dataSourceUrl: string;
  confidenceScore: string;
  investmentStage?: string;
  sector?: string;
  extractionMethod?: string;
}

interface EnrichmentResult {
  companyName: string;
  websiteUrl: string;
  description: string;
  websiteVerified: boolean;
  verificationMessage: string;
  investorType: string[];
  investorTypeConfidence: string;
  investorTypeSourceUrl: string;
  investmentStages: string[];
  investmentStagesConfidence: string;
  investmentStagesSourceUrl: string;
  investmentNiches: string[];
  nichesConfidence: string;
  nichesSourceUrl: string;
  teamMembers: TeamMember[];
  portfolioCompanies: PortfolioCompany[];
}

/**
 * Normalize URL to ensure it has proper protocol
 */
function normalizeUrl(url: string): string {
  if (!url) return url;
  
  // Remove whitespace
  url = url.trim();
  
  // Add protocol if missing
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }
  
  // Remove trailing slash
  url = url.replace(/\/$/, '');
  
  return url;
}

/**
 * Retry helper with exponential backoff
 * @param fn Function to retry
 * @param maxAttempts Maximum number of attempts (default: 3)
 * @param baseDelay Base delay in ms (default: 2000)
 * @returns Result of the function
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelay = 2000
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      // Don't retry on certain errors (404, 403, etc.)
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (message.includes('404') || message.includes('403') || message.includes('not found')) {
          throw error; // Don't retry on client errors
        }
      }
      
      if (attempt < maxAttempts) {
        const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff
        console.log(`[Retry] Attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError || new Error('Max retry attempts reached');
}

export class VCEnrichmentService {
  private async fetchWebpage(url: string, useBrowser = false): Promise<string | null> {
    // For team/people pages, use browser to handle JS-rendered content
    if (useBrowser || url.includes('/team') || url.includes('/people') || url.includes('/about')) {
      // Determine timeout based on page type
      // Team/people pages: 20s (faster, less content)
      // Homepage/verification: 45s (slower, more content, heavy JS)
      const isTeamPage = url.includes('/team') || url.includes('/people') || url.includes('/about');
      const timeout = isTeamPage ? 20000 : 45000;
      
      console.log(`[Fetch] Using comprehensive scraper for: ${url} (timeout: ${timeout}ms)`);
      const { scrapeWebsite } = await import('./scraper');
      const result = await scrapeWebsite({
        url,
        cache: true,
        cacheTTL: 7 * 24 * 60 * 60, // 7 days
        timeout,
      });
      if (result.success && result.html) {
        return result.html;
      }
      // Fallback to axios if scraper fails, but catch 404 errors gracefully
      try {
        console.log(`[Fetch] Scraper failed, trying axios fallback for ${url}`);
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });
        return response.data;
      } catch (error) {
        // If axios fails (e.g., 404, anti-bot protection), return null
        console.log(`[Fetch] Axios fallback failed for ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        return null;
      }
    }
    
    // For other pages, use regular axios
    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });
      return response.data;
    } catch (error) {
      return null;
    }
  }

  private extractTextFromHtml(html: string, maxLength?: number): string {
    const $ = cheerio.load(html);

    // Remove script, style, nav, footer, header elements
    $("script, style, nav, footer, header").remove();

    // Get text
    let text = $("body").text();

    // Clean up whitespace
    text = text.replace(/\s+/g, " ").trim();

    if (maxLength) {
      text = text.substring(0, maxLength);
    }

    return text;
  }

  async verifyWebsite(
    url: string,
    companyName: string,
    description: string,
  ): Promise<{ verified: boolean; message: string }> {
    // Wrap fetchWebpage with retry logic for better reliability
    const html = await retryWithBackoff(() => this.fetchWebpage(url), 3, 2000).catch(() => null);
    if (!html) {
      return { verified: false, message: "Unable to fetch website" };
    }

    const text = this.extractTextFromHtml(html, 3000);

    const prompt = `You are verifying if a website belongs to a specific company.

Company Name: ${companyName}
Company Description: ${description}

Website URL: ${url}
Website Content (first 3000 characters):
${text}

Does this website belong to the company "${companyName}"? 
Respond with ONLY "YES" or "NO" followed by a brief explanation (one sentence).`;

    try {
      const response = await queuedLLMCall({
        messages: [{ role: "user", content: prompt }],
      }, 1); // Priority 1 for verification

      const content = response.choices[0]?.message?.content;
      const answer = (typeof content === 'string' ? content : '').trim();
      const verified = answer.toUpperCase().startsWith("YES");

      return { verified, message: answer };
    } catch (error) {
      // Sanitize error message for Excel output
      let userMessage = "Verification unavailable";
      
      if (error instanceof Error) {
        const errorMsg = error.message.toLowerCase();
        
        if (errorMsg.includes("412") || errorMsg.includes("429") || errorMsg.includes("rate limit") || errorMsg.includes("usage exhausted")) {
          userMessage = "Verification temporarily unavailable (rate limit)";
        } else if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
          userMessage = "Verification timed out";
        } else if (errorMsg.includes("404") || errorMsg.includes("not found") || errorMsg.includes("status code 404")) {
          userMessage = "Website not accessible (404)";
        } else if (errorMsg.includes("403") || errorMsg.includes("forbidden")) {
          userMessage = "Website blocked access (403)";
        } else if (errorMsg.includes("500") || errorMsg.includes("502") || errorMsg.includes("503")) {
          userMessage = "Website server error";
        } else if (errorMsg.includes("enotfound") || errorMsg.includes("dns")) {
          userMessage = "Website domain not found";
        } else if (errorMsg.includes("econnrefused") || errorMsg.includes("connection refused")) {
          userMessage = "Website connection refused";
        }
      }
      
      // Log detailed error for debugging
      console.error(`[Verification Error] ${companyName} (${url}):`, error);
      
      return { verified: false, message: userMessage };
    }
  }

  async extractInvestmentNiches(
    url: string,
    companyName: string,
  ): Promise<{ niches: string[]; sourceUrl: string; confidence: string }> {
    const html = await this.fetchWebpage(url);
    if (!html) {
      return { niches: [], sourceUrl: url, confidence: "Low" };
    }

    const text = this.extractTextFromHtml(html, 5000);
    const nicheTaxonomy = formatNichesForPrompt();

    const prompt = `You are analyzing a venture capital firm's website to identify their investment focus areas.

Company: ${companyName}

Website Content:
${text}

Based on the content above, identify which investment niches this VC firm focuses on. Use ONLY the niches from this predefined taxonomy:

${nicheTaxonomy}

You can select multiple niches. Return your answer as a JSON object with a "niches" key containing an array of niche names exactly as they appear in the taxonomy.

Example format:
{"niches": ["Artificial Intelligence (AI) & Machine Learning (ML)", "SaaS", "FinTech"]}

If you cannot determine the investment focus, return: {"niches": []}`;

    try {
      const response = await queuedLLMCall({
        messages: [{ role: "user", content: prompt }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "investment_niches",
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
      const confidence = niches.length > 0 ? "High" : "Low";

      return { niches, sourceUrl: url, confidence };
    } catch (error) {
      console.error("Error extracting niches:", error);
      return { niches: [], sourceUrl: url, confidence: "Low" };
    }
  }

  async extractInvestorType(
    url: string,
    companyName: string,
    description: string,
  ): Promise<{ types: string[]; sourceUrl: string; confidence: string }> {
    const html = await this.fetchWebpage(url);
    if (!html) {
      return { types: [], sourceUrl: url, confidence: "Low" };
    }

    const text = this.extractTextFromHtml(html);
    const investorTaxonomy = formatInvestorTypesForPrompt();

    const prompt = `You are analyzing a firm to determine what type of investor they are.

Company: ${companyName}
Description: ${description}
Website Content:
${text}

Based on the content above, identify what type of investor this firm is. Use ONLY the types from this predefined taxonomy:

${investorTaxonomy}

You can select multiple types if applicable. Return your answer as a JSON object with a "types" key containing an array of type names exactly as they appear in the taxonomy.

Example format:
{"types": ["Venture Capital (VC)", "Micro VC"]}

If you cannot determine the investor type, return: {"types": []}`;

    try {
      const response = await queuedLLMCall({
        messages: [{ role: "user", content: prompt }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "investor_types",
            strict: true,
            schema: {
              type: "object",
              properties: {
                types: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["types"],
              additionalProperties: false,
            },
          },
        },
      });

      const content = response.choices[0]?.message?.content;
      const result = JSON.parse(typeof content === 'string' ? content : '{}');
      const types = result.types || [];
      const confidence = types.length > 0 ? "High" : "Low";

      return { types, sourceUrl: url, confidence };
    } catch (error) {
      console.error("Error extracting investor type:", error);
      return { types: [], sourceUrl: url, confidence: "Low" };
    }
  }

  async extractInvestmentStages(
    url: string,
    companyName: string,
    description: string,
  ): Promise<{ stages: string[]; sourceUrl: string; confidence: string }> {
    const html = await this.fetchWebpage(url);
    if (!html) {
      return { stages: [], sourceUrl: url, confidence: "Low" };
    }

    const text = this.extractTextFromHtml(html);
    const stagesTaxonomy = formatInvestmentStagesForPrompt();

    const prompt = `You are analyzing a VC firm to determine what investment stages they focus on.

Company: ${companyName}
Description: ${description}
Website Content:
${text}

Based on the content above, identify what investment stages this firm focuses on. Use ONLY the stages from this predefined taxonomy:

${stagesTaxonomy}

You can select multiple stages if the firm invests across different stages. Return your answer as a JSON object with a "stages" key containing an array of stage names exactly as they appear in the taxonomy.

Example format:
{"stages": ["Seed", "Series A", "Series B"]}

If you cannot determine the investment stages, return: {"stages": []}`;

    try {
      const response = await queuedLLMCall({
        messages: [{ role: "user", content: prompt }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "investment_stages",
            strict: true,
            schema: {
              type: "object",
              properties: {
                stages: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["stages"],
              additionalProperties: false,
            },
          },
        },
      });

      const content = response.choices[0]?.message?.content;
      const result = JSON.parse(typeof content === 'string' ? content : '{}');
      const stages = result.stages || [];
      const confidence = stages.length > 0 ? "High" : "Low";

      return { stages, sourceUrl: url, confidence };
    } catch (error) {
      console.error("Error extracting investment stages:", error);
      return { stages: [], sourceUrl: url, confidence: "Low" };
    }
  }

  async extractTeamMembers(url: string, companyName: string): Promise<TeamMember[]> {
    console.log(`\n========================================`);
    console.log(`[extractTeamMembers] Starting for: ${companyName}`);
    console.log(`[extractTeamMembers] Base URL: ${url}`);
    console.log(`========================================`);
    
    // Try common team page URLs - expanded patterns
    const teamUrls = [
      `${url}/team`,
      `${url}/about`,
      `${url}/people`,
      `${url}/meet-the-team`,
      `${url}/our-team`,
      `${url}/leadership`,
      `${url}/about-us`,
      `${url}/who-we-are`,
      url  // Homepage last as fallback
    ];

    let html: string | null = null;
    let teamUrl = url;

    for (const tryUrl of teamUrls) {
      console.log(`[extractTeamMembers] Trying URL: ${tryUrl}`);
      html = await this.fetchWebpage(tryUrl, true);
      if (html) {
        console.log(`[extractTeamMembers] Fetched ${html.length} chars from ${tryUrl}`);
        if (html.toLowerCase().includes("team") || html.toLowerCase().includes("people")) {
          teamUrl = tryUrl;
          console.log(`[extractTeamMembers] ✓ Found team page at: ${teamUrl}`);
          break;
        }
      } else {
        console.log(`[extractTeamMembers] ✗ Failed to fetch ${tryUrl}`);
      }
    }

    if (!html) {
      console.log(`[extractTeamMembers] ✗ No HTML found for any team URL`);
      console.log(`========================================\n`);
      return [];
    }
    
    console.log(`[extractTeamMembers] Using team URL: ${teamUrl}`);
    console.log(`[extractTeamMembers] HTML length: ${html.length} characters`);

    try {
      // Use comprehensive extraction (handles large pages with chunking)
      console.log(`[extractTeamMembers] Calling extractTeamMembersComprehensive...`);
      let members = await extractTeamMembersComprehensive(
        html,
        companyName,
        (msg) => console.log(`[Team Extraction] ${msg}`)
      );
      
      console.log(`[extractTeamMembers] LLM extracted ${members.length} raw members`);
      if (members.length > 0) {
        console.log(`[extractTeamMembers] Sample extracted members:`);
        members.slice(0, 5).forEach((m, idx) => {
          console.log(`  ${idx + 1}. ${m.name} - "${m.title}" - Function: "${m.job_function}"`);
        });
      }
      
      // Check for additional pages (pagination)
      const additionalPages = await detectAndFetchAdditionalTeamPages(html, teamUrl);
      
      if (additionalPages.length > 0) {
        console.log(`[Team Extraction] Found ${additionalPages.length} additional team pages`);
        
        for (const pageUrl of additionalPages) {
          const pageHtml = await this.fetchWebpage(pageUrl, true);
          if (pageHtml) {
            const pageMembers = await extractTeamMembersComprehensive(
              pageHtml,
              companyName,
              (msg) => console.log(`[Team Extraction - Page ${additionalPages.indexOf(pageUrl) + 2}] ${msg}`)
            );
            
            // Deduplicate
            for (const member of pageMembers) {
              const exists = members.find(
                m => m.name.toLowerCase() === member.name.toLowerCase()
              );
              if (!exists) {
                members.push(member);
              }
            }
          }
        }
      }
      
      console.log(`[Team Extraction] Total members after pagination: ${members.length}`);

      // NEW: Extract team member profile links for detail page extraction
      console.log(`[extractTeamMembers] Checking for clickable profile links...`);
      const { extractTeamMemberProfileLinks, extractTeamMemberDetails } = await import('./teamMemberDetailExtractor');
      const profileLinks = extractTeamMemberProfileLinks(html, teamUrl);
      console.log(`[extractTeamMembers] Found ${profileLinks.size} profile links`);
      
      // Extract details from profile pages (limit to first 20 to avoid timeout)
      const memberDetailsMap = new Map<string, any>();
      let detailsExtracted = 0;
      
      for (const [memberName, profileUrl] of Array.from(profileLinks.entries()).slice(0, 20)) {
        try {
          const profileHtml = await this.fetchWebpage(profileUrl, true);
          if (profileHtml) {
            const details = await extractTeamMemberDetails(profileHtml, memberName, profileUrl);
            if (details) {
              memberDetailsMap.set(memberName.toLowerCase(), details);
              detailsExtracted++;
            }
          }
        } catch (error) {
          console.error(`[extractTeamMembers] Error extracting details for ${memberName}:`, error);
        }
      }
      
      console.log(`[extractTeamMembers] Extracted details from ${detailsExtracted} profile pages`);

      // Extract and match LinkedIn URLs to team members (website-based only)
      console.log(`[extractTeamMembers] Extracting LinkedIn URLs from HTML...`);
      const memberNames = members.map((m) => m.name);
      const linkedinMatches = extractAndMatchLinkedInURLs(html, memberNames);
      console.log(`[extractTeamMembers] Found ${linkedinMatches.length} LinkedIn URL matches`);

      // Map team members to enriched format with LinkedIn URLs
      const enrichedMembers = await Promise.all(
        members.map(async (member: any) => {
          const match = linkedinMatches.find(m => m.name === member.name);
          
          let linkedinUrl = match?.linkedinUrl || "";
          let confidenceScore = match ? match.confidence : "Low";
          
          // If no LinkedIn URL found via extraction, try smart URL construction
          if (!linkedinUrl && member.name) {
            console.log(`[Smart URL Fallback] Attempting smart URL construction for: ${member.name}`);
            try {
              const smartResult = await findLinkedInURLForPerson(member.name, false);
              if (smartResult) {
                linkedinUrl = smartResult.url;
                confidenceScore = smartResult.confidence;
                console.log(`[Smart URL Fallback] ✓ Found via ${smartResult.method}: ${linkedinUrl}`);
              }
            } catch (error) {
              console.error(`[Smart URL Fallback] Error for ${member.name}:`, error);
            }
          }
          
          // Check if we have detail page data for this member
          const detailData = memberDetailsMap.get(member.name.toLowerCase());
          
          // Merge detail page data
          let finalLinkedinUrl = linkedinUrl;
          let finalSpecialization = member.specialization;
          
          if (detailData) {
            // Prefer LinkedIn URL from detail page if available
            if (detailData.linkedinUrl) {
              finalLinkedinUrl = detailData.linkedinUrl;
              confidenceScore = "High";
            }
            
            // Enhance specialization with investment philosophy
            if (detailData.investmentPhilosophy) {
              finalSpecialization = detailData.investmentPhilosophy;
            }
          }
          
          return {
            name: member.name,
            title: member.title,
            jobFunction: member.job_function,
            specialization: finalSpecialization,
            linkedinUrl: finalLinkedinUrl,
            dataSourceUrl: teamUrl,
            confidenceScore,
          };
        })
      );
      
      console.log(`[extractTeamMembers] Final enriched members: ${enrichedMembers.length}`);
      console.log(`========================================\n`);
      return enrichedMembers;
    } catch (error) {
      console.error("[extractTeamMembers] ✗ Error:", error);
      console.log(`========================================\n`);
      return [];
    }
  }

  async extractPortfolioCompanies(url: string, companyName: string): Promise<PortfolioCompany[]> {
    const { 
      getPortfolioUrlPatterns, 
      extractPortfolioFromHTML, 
      enrichPortfolioCandidates,
      extractPortfolioWithLLM 
    } = await import('./portfolioExtractor');
    
    console.log(`[extractPortfolioCompanies] Starting for: ${companyName}`);
    console.log(`[extractPortfolioCompanies] Base URL: ${url}`);
    
    // Try comprehensive portfolio page URLs
    const portfolioUrls = getPortfolioUrlPatterns(url);

    let html: string | null = null;
    let portfolioUrl = url;

    // Try each portfolio URL pattern
    for (const tryUrl of portfolioUrls) {
      console.log(`[extractPortfolioCompanies] Trying URL: ${tryUrl}`);
      html = await this.fetchWebpage(tryUrl, true); // Use browser for JS-rendered content
      if (
        html &&
        (html.toLowerCase().includes("portfolio") || 
         html.toLowerCase().includes("investment") ||
         html.toLowerCase().includes("companies") ||
         html.toLowerCase().includes("holdings"))
      ) {
        portfolioUrl = tryUrl;
        console.log(`[extractPortfolioCompanies] ✓ Found portfolio page at: ${portfolioUrl}`);
        break;
      }
    }

    if (!html) {
      console.log(`[extractPortfolioCompanies] ✗ No portfolio page found`);
      return [];
    }

    console.log(`[extractPortfolioCompanies] Using portfolio URL: ${portfolioUrl}`);
    console.log(`[extractPortfolioCompanies] HTML length: ${html.length} characters`);

    try {
      // Strategy 1: HTML parsing to extract links and images
      const candidates = extractPortfolioFromHTML(html, portfolioUrl);
      
      if (candidates.length > 0) {
        console.log(`[extractPortfolioCompanies] HTML parsing found ${candidates.length} candidates`);
        
        // Enrich candidates with LLM (increased context window)
        const text = this.extractTextFromHtml(html, 20000);
        const enriched = await enrichPortfolioCandidates(candidates, text, companyName);
        
        // Add dataSourceUrl
        enriched.forEach(company => {
          company.dataSourceUrl = portfolioUrl;
        });
        
        console.log(`[extractPortfolioCompanies] ✓ Extracted ${enriched.length} portfolio companies via HTML parsing`);
        return enriched;
      }
      
      // Strategy 2: Fallback to pure LLM extraction
      console.log(`[extractPortfolioCompanies] HTML parsing found nothing, trying pure LLM extraction`);
      const text = this.extractTextFromHtml(html, 20000);
      const companies = await extractPortfolioWithLLM(text, portfolioUrl, companyName);
      
      console.log(`[extractPortfolioCompanies] ✓ Extracted ${companies.length} portfolio companies via LLM`);
      return companies;
      
    } catch (error) {
      console.error("[extractPortfolioCompanies] Error extracting portfolio companies:", error);
      return [];
    }
  }

  async enrichVCFirm(
    companyName: string,
    websiteUrl: string,
    description: string,
    onProgress?: (message: string) => void,
  ): Promise<EnrichmentResult> {
    try {
      // Normalize URL to fix common issues (missing protocol, trailing slash, etc.)
      websiteUrl = normalizeUrl(websiteUrl);
      
      onProgress?.(`Starting enrichment for ${companyName}`);

      const result: EnrichmentResult = {
      companyName,
      websiteUrl,
      description,
      websiteVerified: false,
      verificationMessage: "",
      investorType: [],
      investorTypeConfidence: "Low",
      investorTypeSourceUrl: websiteUrl,
      investmentStages: [],
      investmentStagesConfidence: "Low",
      investmentStagesSourceUrl: websiteUrl,
      investmentNiches: [],
      nichesConfidence: "Low",
      nichesSourceUrl: websiteUrl,
      teamMembers: [],
      portfolioCompanies: [],
    };

    // Step 1: Verify website
    onProgress?.(`Verifying website for ${companyName}`);
    const verification = await this.verifyWebsite(websiteUrl, companyName, description);
    result.websiteVerified = verification.verified;
    result.verificationMessage = verification.message;

    // Step 2: Extract investor type
    onProgress?.(`Identifying investor type for ${companyName}`);
    const investorTypeData = await this.extractInvestorType(websiteUrl, companyName, description);
    result.investorType = investorTypeData.types;
    result.investorTypeConfidence = investorTypeData.confidence;
    result.investorTypeSourceUrl = investorTypeData.sourceUrl;

    // Step 3: Extract investment stages
    onProgress?.(`Identifying investment stages for ${companyName}`);
    const investmentStagesData = await this.extractInvestmentStages(websiteUrl, companyName, description);
    result.investmentStages = investmentStagesData.stages;
    result.investmentStagesConfidence = investmentStagesData.confidence;
    result.investmentStagesSourceUrl = investmentStagesData.sourceUrl;

    // Step 4: Extract investment niches
    onProgress?.(`Extracting investment niches for ${companyName}`);
    const niches = await this.extractInvestmentNiches(websiteUrl, companyName);
    result.investmentNiches = niches.niches;
    result.nichesConfidence = niches.confidence;
    result.nichesSourceUrl = niches.sourceUrl;

    // Waterfall enrichment for low-confidence investor type
    if (result.investorTypeConfidence === "Low" || result.investorType.length === 0) {
      onProgress?.(`Low confidence on investor type, trying additional sources...`);
      const { waterfallFetchMultiple } = await import("./waterfallEnrichment");
      const waterfallData = await waterfallFetchMultiple(websiteUrl, 2, onProgress);
      
      if (waterfallData.combinedText) {
        const retryTypeData = await this.extractInvestorType(websiteUrl, companyName, waterfallData.combinedText);
        if (retryTypeData.confidence === "High" && retryTypeData.types.length > 0) {
          result.investorType = retryTypeData.types;
          result.investorTypeConfidence = "Medium (Waterfall)";
          result.investorTypeSourceUrl = waterfallData.sourceUrls.join(", ");
          onProgress?.(`Improved investor type confidence via waterfall`);
        }
      }
    }

    // Waterfall enrichment for low-confidence investment stages
    if (result.investmentStagesConfidence === "Low" || result.investmentStages.length === 0) {
      onProgress?.(`Low confidence on investment stages, trying additional sources...`);
      const { waterfallFetchMultiple } = await import("./waterfallEnrichment");
      const waterfallData = await waterfallFetchMultiple(websiteUrl, 2, onProgress);
      
      if (waterfallData.combinedText) {
        const retryStagesData = await this.extractInvestmentStages(websiteUrl, companyName, waterfallData.combinedText);
        if (retryStagesData.confidence === "High" && retryStagesData.stages.length > 0) {
          result.investmentStages = retryStagesData.stages;
          result.investmentStagesConfidence = "Medium (Waterfall)";
          result.investmentStagesSourceUrl = waterfallData.sourceUrls.join(", ");
          onProgress?.(`Improved investment stages confidence via waterfall`);
        }
      }
    }

    // Waterfall enrichment for low-confidence investment niches
    if (result.nichesConfidence === "Low" || result.investmentNiches.length === 0) {
      onProgress?.(`Low confidence on investment niches, trying additional sources...`);
      const { waterfallFetchMultiple } = await import("./waterfallEnrichment");
      const waterfallData = await waterfallFetchMultiple(websiteUrl, 2, onProgress);
      
      if (waterfallData.combinedText) {
        const retryNichesData = await this.extractInvestmentNiches(websiteUrl, companyName);
        if (retryNichesData.confidence === "High" && retryNichesData.niches.length > 0) {
          result.investmentNiches = retryNichesData.niches;
          result.nichesConfidence = "Medium (Waterfall)";
          result.nichesSourceUrl = waterfallData.sourceUrls.join(", ");
          onProgress?.(`Improved investment niches confidence via waterfall`);
        }
      }
    }

    // Step 5: Extract team members
    onProgress?.(`Extracting team members for ${companyName}`);
    result.teamMembers = await this.extractTeamMembers(websiteUrl, companyName);

    // Step 6: Extract portfolio companies
    onProgress?.(`Extracting portfolio companies for ${companyName}`);
    result.portfolioCompanies = await this.extractPortfolioCompanies(websiteUrl, companyName);

    // Step 7: Waterfall enrichment for team member specialization
    // DISABLED - This is too slow for large teams (5+ minutes for 250 members)
    // TODO: Implement batch processing or parallel execution
    /*
    onProgress?.(`Enriching team member specializations for ${companyName}`);
    const teamPageHtml = await this.fetchWebpage(`${websiteUrl}/team`) || 
                        await this.fetchWebpage(`${websiteUrl}/about`) || 
                        await this.fetchWebpage(websiteUrl) || "";
    const portfolioPageHtml = await this.fetchWebpage(`${websiteUrl}/portfolio`) || 
                             await this.fetchWebpage(`${websiteUrl}/companies`) || "";

    // Only enrich first 50 members to avoid timeouts
    const membersToEnrich = result.teamMembers.slice(0, 50);
    
    for (const member of membersToEnrich) {
      // Only enrich if specialization is empty or low confidence
      if (!member.specialization || member.confidenceScore === "Low") {
        const enriched = await enrichTeamMemberSpecialization(
          member.name,
          member.linkedinUrl,
          teamPageHtml,
          portfolioPageHtml,
          onProgress
        );

        if (enriched.finalNiches.length > 0) {
          member.specialization = enriched.finalNiches.join(", ");
          member.confidenceScore = enriched.confidence;
        }
      }
    }
    */

      onProgress?.(`Completed enrichment for ${companyName}`);

      return result;
    } catch (error) {
      // CRITICAL: Never throw - always return a result object
      console.error(`[enrichVCFirm] Fatal error for ${companyName}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        companyName,
        websiteUrl,
        description,
        websiteVerified: false,
        verificationMessage: `Error: ${errorMessage}`,
        investorType: [],
        investorTypeConfidence: "Error",
        investorTypeSourceUrl: websiteUrl,
        investmentStages: [],
        investmentStagesConfidence: "Error",
        investmentStagesSourceUrl: websiteUrl,
        investmentNiches: [],
        nichesConfidence: "Error",
        nichesSourceUrl: websiteUrl,
        teamMembers: [],
        portfolioCompanies: [],
      };
    }
  }
}
