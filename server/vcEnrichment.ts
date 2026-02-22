/**
 * VC Enrichment Service
 * Handles the extraction and enrichment of VC firm data
 */
import { invokeLLM } from "./_core/openaiLLM";
// Removed queuedLLMCall - using direct OpenAI calls now
import { aggregateFreeApiData } from "./dataSources/freeApis";
import { formatNichesForPrompt } from "./nicheTaxonomy";
import { formatInvestorTypesForPrompt, formatInvestmentStagesForPrompt } from "./investorTaxonomy";
import { extractAndMatchLinkedInURLs } from "./improvedLinkedInExtractor";
import { findLinkedInURLForPerson } from "./smartUrlConstructor";
import { enrichTeamMemberSpecialization } from "./teamMemberEnrichment";
import { extractTeamMembersComprehensive, detectAndFetchAdditionalTeamPages } from "./comprehensiveTeamExtraction";
import { findPersonByName } from './nameNormalization';
import axios from "axios";
import * as cheerio from "cheerio";
import { fetchViaJina, fetchWebsiteContentHybrid, fetchStats } from "./jinaFetcher";
import { scrapeComprehensively, getTeamSpecificContent, getPortfolioSpecificContent, aggregateAllContent, type ComprehensiveScrapingResult } from "./comprehensiveMultiPageScraper";
import { scrapeRecursively, type RecursiveScrapingResult } from "./recursiveScraper";
import { type ScrapeProfile, VC_PROFILE } from "./scrapeProfile";

/**
 * Extract emails from HTML and try to match them to team member names
 */
function extractEmailsFromHTML(html: string, memberNames: string[]): Map<string, string> {
  const emailMap = new Map<string, string>();
  const $ = cheerio.load(html);
  
  // Extract all emails from mailto: links
  const allEmails: string[] = [];
  $('a[href^="mailto:"]').each((_, elem) => {
    const href = $(elem).attr('href');
    if (href) {
      const email = href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
      if (email.match(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/)) {
        allEmails.push(email);
      }
    }
  });
  
  // Also extract emails from text content
  const pageText = $('body').text();
  const textEmailMatches = pageText.match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g);
  if (textEmailMatches) {
    for (const email of textEmailMatches) {
      const lowerEmail = email.toLowerCase();
      // Filter out generic/false positive emails
      if (!lowerEmail.includes('example.com') && 
          !lowerEmail.includes('placeholder') &&
          !lowerEmail.startsWith('info@') &&
          !lowerEmail.startsWith('contact@') &&
          !lowerEmail.startsWith('hello@') &&
          !lowerEmail.startsWith('support@') &&
          !lowerEmail.startsWith('careers@') &&
          !lowerEmail.startsWith('press@') &&
          !lowerEmail.startsWith('media@') &&
          !allEmails.includes(lowerEmail)) {
        allEmails.push(lowerEmail);
      }
    }
  }
  
  console.log(`[extractEmailsFromHTML] Found ${allEmails.length} unique emails on page`);
  
  // Try to match emails to member names
  for (const memberName of memberNames) {
    const nameParts = memberName.toLowerCase().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts[nameParts.length - 1] || '';
    
    for (const email of allEmails) {
      const emailLocal = email.split('@')[0];
      
      // Match patterns like: firstname.lastname, firstnamelastname, firstname, f.lastname, flastname
      if (emailLocal.includes(firstName) && emailLocal.includes(lastName)) {
        emailMap.set(memberName, email);
        console.log(`[extractEmailsFromHTML] Matched email ${email} to ${memberName}`);
        break;
      } else if (emailLocal === firstName || emailLocal === `${firstName}.${lastName}` || emailLocal === `${firstName}${lastName}`) {
        emailMap.set(memberName, email);
        console.log(`[extractEmailsFromHTML] Matched email ${email} to ${memberName}`);
        break;
      } else if (firstName.length > 0 && lastName.length > 0 && emailLocal === `${firstName[0]}${lastName}`) {
        emailMap.set(memberName, email);
        console.log(`[extractEmailsFromHTML] Matched email ${email} to ${memberName}`);
        break;
      }
    }
  }
  
  console.log(`[extractEmailsFromHTML] Matched ${emailMap.size}/${memberNames.length} members to emails`);
  return emailMap;
}

interface TeamMember {
  name: string;
  title: string;
  jobFunction: string;
  specialization: string;
  linkedinUrl: string;
  email: string;
  portfolioCompanies: string; // Comma-separated list of portfolio companies associated with this team member
  // Individual investment mandate fields
  investmentFocus: string;
  stagePreference: string;
  checkSizeRange: string;
  geographicFocus: string;
  investmentThesis: string;
  notableInvestments: string;
  yearsExperience: string;
  background: string;
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

export interface EnrichmentResult {
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
  firmData?: {
    investmentThesis?: string;
    aum?: string;
    investmentStages?: string[];
    sectorFocus?: string[];
    geographicFocus?: string[];
    foundedYear?: string;
    headquarters?: string;
  };
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
  private profile: ScrapeProfile;

  constructor(profile?: ScrapeProfile) {
    this.profile = profile ?? VC_PROFILE;
  }

  private async fetchWebpage(url: string, useBrowser = false): Promise<string | null> {
    // Hybrid approach: Try Jina first (fast), fallback to Puppeteer (reliable)
    const isTeamPage = url.includes('/team') || url.includes('/people') || url.includes('/about');
    const puppeteerTimeout = isTeamPage ? 20000 : 45000;
    
    // Puppeteer fallback function
    const puppeteerFallback = async (): Promise<string | null> => {
      try {
        console.log(`[Fetch] Using Puppeteer for: ${url} (timeout: ${puppeteerTimeout}ms)`);
        const { scrapeWebsite } = await import('./scraper');
        const result = await scrapeWebsite({
          url,
          cache: true,
          cacheTTL: 7 * 24 * 60 * 60, // 7 days
          timeout: puppeteerTimeout,
        });
        if (result.success && result.html) {
          fetchStats.recordPuppeteerSuccess(puppeteerTimeout);
          return result.html;
        }
        fetchStats.recordPuppeteerFailure();
        return null;
      } catch (error) {
        console.log(`[Fetch] Puppeteer failed: ${error instanceof Error ? error.message : String(error)}`);
        fetchStats.recordPuppeteerFailure();
        return null;
      }
    };
    
    // Use hybrid approach if useBrowser is true or it's a team/people/about page
    if (useBrowser || isTeamPage) {
      console.log(`[Fetch] Using Jina + Puppeteer hybrid for: ${url}`);
      const result = await fetchWebsiteContentHybrid(url, puppeteerFallback);
      
      if (result.success && result.content) {
        if (result.source === 'jina') {
          fetchStats.recordJinaSuccess(result.duration);
        }
        return result.content;
      }
      return null;
    }
    
    // For other pages, try Jina first, then axios
    try {
      console.log(`[Fetch] Trying Jina for: ${url}`);
      const jinaResult = await fetchViaJina(url);
      if (jinaResult?.success && jinaResult.content) {
        fetchStats.recordJinaSuccess(jinaResult.duration);
        return jinaResult.content;
      }
      fetchStats.recordJinaFailure();
    } catch (error) {
      console.log(`[Fetch] Jina error: ${error instanceof Error ? error.message : String(error)}`);
      fetchStats.recordJinaFailure();
    }
    
    // Fallback to axios
    try {
      console.log(`[Fetch] Falling back to axios for: ${url}`);
      const response = await axios.get(url, {
        timeout: 30000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });
      return response.data;
    } catch (error) {
      console.log(`[Fetch] All fetch methods failed for ${url}`);
      return null;
    }
  }

  // Special version for verification that throws errors (enables error categorization)
  private async fetchWebpageForVerification(url: string): Promise<string> {
    // Generate URL variants to try (www/non-www, https/http)
    const urlVariants = this.generateUrlVariants(url);
    
    let lastError: Error | null = null;
    
    // Try each URL variant
    for (const tryUrl of urlVariants) {
      try {
        console.log(`[FetchForVerification] Trying URL: ${tryUrl}`);
        
        // Try scraper first for JS-rendered sites
        const { scrapeWebsite } = await import('./scraper');
        const result = await scrapeWebsite({
          url: tryUrl,
          cache: true,
          cacheTTL: 7 * 24 * 60 * 60,
          timeout: 45000,
        });
        
        if (result.success && result.html) {
          console.log(`[FetchForVerification] ✓ Success with ${tryUrl}`);
          return result.html;
        }
        
        // Fallback to axios
        const response = await axios.get(tryUrl, {
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });
        console.log(`[FetchForVerification] ✓ Success with axios: ${tryUrl}`);
        return response.data;
      } catch (error) {
        lastError = error as Error;
        const message = lastError.message.toLowerCase();
        
        // For 409 errors, retry after delay
        if (message.includes('409') || message.includes('conflict')) {
          console.log(`[FetchForVerification] 409 error, retrying after 3s...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          // Retry once
          try {
            const response = await axios.get(tryUrl, {
              timeout: 15000,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              },
            });
            console.log(`[FetchForVerification] ✓ 409 retry succeeded: ${tryUrl}`);
            return response.data;
          } catch (retryError) {
            console.log(`[FetchForVerification] 409 retry failed: ${tryUrl}`);
            lastError = retryError as Error;
          }
        }
        
        // For 403 errors, try with stealth mode (via scraper)
        if (message.includes('403') || message.includes('forbidden')) {
          console.log(`[FetchForVerification] 403 error, trying stealth mode...`);
          try {
            const { scrapeWebsite } = await import('./scraper');
            const stealthResult = await scrapeWebsite({
              url: tryUrl,
              cache: false,
              timeout: 45000,
            });
            
            if (stealthResult.success && stealthResult.html) {
              console.log(`[FetchForVerification] ✓ Stealth mode succeeded: ${tryUrl}`);
              return stealthResult.html;
            }
          } catch (stealthError) {
            console.log(`[FetchForVerification] Stealth mode failed: ${tryUrl}`);
            lastError = stealthError as Error;
          }
        }
        
        // For 404 errors, try next URL variant immediately
        if (message.includes('404') || message.includes('not found')) {
          console.log(`[FetchForVerification] 404 error, trying next variant...`);
          continue;
        }
        
        // For DNS errors, try next variant
        if (message.includes('enotfound') || message.includes('dns')) {
          console.log(`[FetchForVerification] DNS error, trying next variant...`);
          continue;
        }
        
        // For other errors, log and continue to next variant
        console.log(`[FetchForVerification] Error with ${tryUrl}: ${lastError.message}`);
      }
    }
    
    // All variants failed, throw the last error
    throw lastError || new Error('All URL variants failed');
  }
  
  // Generate URL variants to try (www/non-www, https/http)
  private generateUrlVariants(url: string): string[] {
    const variants: string[] = [url]; // Start with original
    
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;
      const protocol = parsed.protocol;
      const path = parsed.pathname + parsed.search;
      
      // Add www/non-www variants
      if (hostname.startsWith('www.')) {
        const nonWww = hostname.substring(4);
        variants.push(`${protocol}//${nonWww}${path}`);
      } else {
        variants.push(`${protocol}//www.${hostname}${path}`);
      }
      
      // Add https/http variants (only if original is http)
      if (protocol === 'http:') {
        variants.push(`https://${hostname}${path}`);
        if (hostname.startsWith('www.')) {
          const nonWww = hostname.substring(4);
          variants.push(`https://${nonWww}${path}`);
        } else {
          variants.push(`https://www.${hostname}${path}`);
        }
      }
    } catch (error) {
      console.error(`[generateUrlVariants] Error parsing URL: ${url}`, error);
    }
    
    // Remove duplicates
    return Array.from(new Set(variants));
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
    // Wrap fetchWebpageForVerification with retry logic and error categorization
    const html = await retryWithBackoff(() => this.fetchWebpageForVerification(url), 3, 2000).catch((error) => {
      const message = error.message.toLowerCase();
      
      // Categorize errors for better debugging and user feedback
      if (message.includes('enotfound') || message.includes('dns')) {
        console.warn(`[Verification] ❌ Invalid domain: ${url} (DNS lookup failed)`);
        return { error: 'Domain does not exist or DNS lookup failed' };
      }
      
      if (message.includes('timeout') || message.includes('etimedout')) {
        console.warn(`[Verification] ⏱️ Timeout: ${url} (website too slow or unresponsive)`);
        return { error: 'Website timeout - site may be slow or temporarily unavailable' };
      }
      
      if (message.includes('econnrefused') || message.includes('connection refused')) {
        console.warn(`[Verification] 🚫 Connection refused: ${url} (server not accepting connections)`);
        return { error: 'Connection refused - server may be down' };
      }
      
      if (message.includes('403') || message.includes('forbidden')) {
        console.warn(`[Verification] 🛡️ Access blocked: ${url} (anti-bot protection)`);
        return { error: 'Access blocked - website has anti-bot protection' };
      }
      
      if (message.includes('404') || message.includes('not found')) {
        console.warn(`[Verification] 📄 Not found: ${url} (page doesn't exist)`);
        return { error: 'Page not found (404)' };
      }
      
      if (message.includes('circuit breaker')) {
        console.warn(`[Verification] ⚡ Circuit breaker open: ${url} (too many failures)`);
        return { error: 'Circuit breaker open - domain temporarily blocked due to repeated failures' };
      }
      
      // Generic error with full message for debugging
      console.error(`[Verification] ❌ Unexpected error for ${url}:`, error.message);
      return { error: `Failed to fetch: ${error.message.substring(0, 100)}` };
    });
    
    // Check if we got an error object instead of HTML
    if (!html || typeof html !== 'string') {
      const errorMsg = (html as any)?.error || 'Unable to fetch website';
      return { verified: false, message: errorMsg };
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
      const response = await invokeLLM({
        messages: [{ role: "user", content: prompt }],
      });

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
      const response = await invokeLLM({
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
      const response = await invokeLLM({
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
      const response = await invokeLLM({
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

  async extractTeamMembers(
    url: string,
    companyName: string,
    multiPageResult?: ComprehensiveScrapingResult,
    options: {
      deepProfileScraping?: boolean;
      maxProfiles?: number;
    } = {}
  ): Promise<TeamMember[]> {
    const { deepProfileScraping = false, maxProfiles = 200 } = options;
    
    console.log(`\n========================================`);
    console.log(`[extractTeamMembers] Starting for: ${companyName}`);
    console.log(`[extractTeamMembers] Base URL: ${url}`);
    console.log(`[extractTeamMembers] Deep profile scraping: ${deepProfileScraping ? 'ENABLED' : 'DISABLED'}`);
    console.log(`========================================`);
    
    let html: string | null = null;
    let teamUrl = url;
    let variantUrls: string[] = [];
    
    // If multi-page result is provided, use aggregated team content
    if (multiPageResult) {
      console.log(`[extractTeamMembers] Using multi-page scraping result`);
      html = getTeamSpecificContent(multiPageResult);
      teamUrl = url;
      console.log(`[extractTeamMembers] Aggregated content from ${multiPageResult.stats.teamPagesScraped + 1} pages`);
      console.log(`[extractTeamMembers] Total content length: ${html.length} characters`);
      
      // Deep profile scraping: Follow individual team member profile links
      if (deepProfileScraping && html) {
        console.log(`[extractTeamMembers] Starting deep profile scraping...`);
        const { deepScrapeTeamMembers, aggregateTeamContent } = await import('./deepTeamProfileScraper');
        
        const deepResult = await deepScrapeTeamMembers(
          html,
          url,
          this.fetchWebpage.bind(this),
          {
            maxProfiles,
            delayBetweenProfiles: 1500,
            enabled: true,
          }
        );
        
        if (deepResult.stats.successfulScrapes > 0) {
          console.log(`[extractTeamMembers] Deep scraping found ${deepResult.stats.successfulScrapes} individual profiles`);
          html = aggregateTeamContent(html, deepResult.scrapedProfiles);
          console.log(`[extractTeamMembers] Aggregated content now includes ${deepResult.stats.successfulScrapes} individual profiles`);
          console.log(`[extractTeamMembers] New content length: ${html.length} characters`);
        } else {
          console.log(`[extractTeamMembers] No individual profiles found or scraped`);
        }
      }
    } else {
      // Fallback to old method if no multi-page result
      console.log(`[extractTeamMembers] No multi-page result, using legacy method`);
      
      // Accel-specific: Use global team view to get all locations
      if (url.includes("accel.com")) {
        const accelGlobalUrl = `${url}/team#global`.replace(/\/+/g, "/").replace(":/", "://");
        console.log(`[extractTeamMembers] Accel detected, using global view: ${accelGlobalUrl}`);
        html = await this.fetchWebpage(accelGlobalUrl, true);
        if (html && html.length > 1000) {
          console.log(`[extractTeamMembers] Accel global page loaded successfully`);
          teamUrl = accelGlobalUrl;
        }
      }
      
      // Try common team page URLs - expanded patterns
      const teamUrls = [
        `${url}/team`,
        `${url}/people`,
        `${url}/leadership`,
        `${url}/our-team`,
        `${url}/meet-the-team`,
        `${url}/partners`,
        `${url}/investment-team`,
        `${url}/about/team`,
        `${url}/about/people`,
        `${url}/about`,
        `${url}/about-us`,
        `${url}/who-we-are`,
        url  // Homepage last as fallback
      ];

      for (const tryUrl of teamUrls) {
        console.log(`[extractTeamMembers] Trying URL: ${tryUrl}`);
        html = await this.fetchWebpage(tryUrl, true);
        if (html) {
          console.log(`[extractTeamMembers] Fetched ${html.length} chars from ${tryUrl}`);
          teamUrl = tryUrl;
          console.log(`[extractTeamMembers] \u2713 Got content from: ${teamUrl}`);
          break;
        } else {
          console.log(`[extractTeamMembers] \u2717 Failed to fetch ${tryUrl}`);
        }
      }

      if (!html) {
        console.log(`[extractTeamMembers] \u2717 No HTML found for any team URL`);
        console.log(`========================================\n`);
        return [];
      }
      
      console.log(`[extractTeamMembers] Using team URL: ${teamUrl}`);
      console.log(`[extractTeamMembers] HTML length: ${html.length} characters`);
      
      // Detect region/stage-specific team URLs
      console.log(`[extractTeamMembers] Detecting region/stage-specific team URLs...`);
      const { detectTeamUrlVariants } = await import('./teamUrlDetector');
      const variants = await detectTeamUrlVariants(html, teamUrl, companyName);
      
      if (variants.length > 0) {
        console.log(`[extractTeamMembers] Found ${variants.length} team URL variants`);
        variantUrls = variants.map(v => v.url);
      } else {
        console.log(`[extractTeamMembers] No team URL variants detected`);
      }
    }

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
      
      // Scrape region/stage-specific team URLs
      // Collect all HTML pages for profile link detection
      const allHtmlPages: Array<{ html: string; url: string; label: string }> = [
        { html, url: teamUrl, label: 'Main' }
      ];
      
      if (variantUrls.length > 0) {
        console.log(`[Team Extraction] Scraping ${variantUrls.length} region/stage-specific URLs...`);
        
        for (const variantUrl of variantUrls) {
          console.log(`[Team Extraction] Fetching variant: ${variantUrl}`);
          const variantHtml = await this.fetchWebpage(variantUrl, true);
          
          if (variantHtml) {
            // Add to HTML pages for profile link detection
            allHtmlPages.push({ html: variantHtml, url: variantUrl, label: `Variant ${variantUrls.indexOf(variantUrl) + 1}` });
            
            const variantMembers = await extractTeamMembersComprehensive(
              variantHtml,
              companyName,
              (msg) => console.log(`[Team Extraction - Variant ${variantUrls.indexOf(variantUrl) + 1}] ${msg}`)
            );
            
            console.log(`[Team Extraction] Variant ${variantUrls.indexOf(variantUrl) + 1} found ${variantMembers.length} members`);
            
            // Deduplicate by name using robust normalization
            for (const member of variantMembers) {
              const exists = findPersonByName(members, member.name);
              if (!exists) {
                members.push(member);
                console.log(`[Team Extraction] Added new member from variant: ${member.name}`);
              } else {
                console.log(`[Team Extraction] Skipping duplicate from variant: ${member.name} (matches ${exists.name})`);
              }
            }
          } else {
            console.log(`[Team Extraction] Failed to fetch variant: ${variantUrl}`);
          }
        }
        
        console.log(`[Team Extraction] Total members after variant scraping: ${members.length}`);
      }
      
      console.log(`[Team Extraction] Total members after pagination: ${members.length}`);

      // NEW: Extract team member profile links from ALL pages (main + variants)
      console.log(`[extractTeamMembers] Checking for clickable profile links across ${allHtmlPages.length} pages...`);
      const { extractTeamMemberProfileLinks, extractTeamMemberDetails } = await import('./teamMemberDetailExtractor');
      const profileLinks = new Map<string, string>();
      
      for (const page of allHtmlPages) {
        console.log(`[extractTeamMembers] Scanning ${page.label} page for profile links...`);
        const pageLinks = await extractTeamMemberProfileLinks(page.html, page.url);
        console.log(`[extractTeamMembers] Found ${pageLinks.size} profile links on ${page.label} page`);
        
        // Merge into main profileLinks map (deduplicate by name using normalization)
        const { normalizeName } = await import('./nameNormalization');
        for (const [name, url] of Array.from(pageLinks.entries())) {
          const normalizedName = normalizeName(name);
          if (!profileLinks.has(normalizedName)) {
            profileLinks.set(normalizedName, url);
            console.log(`[extractTeamMembers] Added profile link: ${name} → ${url}`);
          } else {
            console.log(`[extractTeamMembers] Skipping duplicate profile link: ${name}`);
          }
        }
      }
      
      console.log(`[extractTeamMembers] Total unique profile links found: ${profileLinks.size}`);
      console.log(`[extractTeamMembers] Profile link detection rate: ${profileLinks.size}/${members.length} (${Math.round(profileLinks.size / members.length * 100)}%)`);
      
      if (profileLinks.size === 0) {
        console.warn(`[extractTeamMembers] ⚠️ WARNING: No profile links found. LinkedIn URLs and specializations will be limited to main page extraction.`);
      }
      
      // Extract details from ALL profile pages with batching
      const memberDetailsMap = new Map<string, any>();
      let detailsExtracted = 0;
      const profileEntries = Array.from(profileLinks.entries());
      const batchSize = 50; // Process 50 profiles at a time
      
      console.log(`[extractTeamMembers] Processing ${profileEntries.length} profile pages in batches of ${batchSize}...`);
      
      for (let i = 0; i < profileEntries.length; i += batchSize) {
        const batch = profileEntries.slice(i, i + batchSize);
        console.log(`[extractTeamMembers] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(profileEntries.length / batchSize)} (${batch.length} profiles)`);
        
        // Process batch in parallel
        const { normalizeName: normalizeNameForBatch } = await import('./nameNormalization');
        await Promise.all(batch.map(async ([memberName, profileUrl]) => {
          try {
            const profileHtml = await this.fetchWebpage(profileUrl, true);
            if (profileHtml) {
              const details = await extractTeamMemberDetails(profileHtml, memberName, profileUrl);
              if (details) {
                memberDetailsMap.set(normalizeNameForBatch(memberName), details);
                detailsExtracted++;
              }
            }
          } catch (error) {
            console.error(`[extractTeamMembers] Error extracting details for ${memberName}:`, error);
          }
        }));
        
        console.log(`[extractTeamMembers] Batch complete. Total extracted: ${detailsExtracted}/${profileEntries.length}`);
      }
      
      console.log(`[extractTeamMembers] Extracted details from ${detailsExtracted} profile pages`);

      // Extract and match LinkedIn URLs to team members (website-based only)
      console.log(`[extractTeamMembers] Extracting LinkedIn URLs from HTML...`);
      const memberNames = members.map((m) => m.name);
      const linkedinMatches = extractAndMatchLinkedInURLs(html, memberNames);
      console.log(`[extractTeamMembers] Found ${linkedinMatches.length} LinkedIn URL matches`);
      
      // Extract emails from main team page HTML
      console.log(`[extractTeamMembers] Extracting emails from team page HTML...`);
      const mainPageEmails = extractEmailsFromHTML(html, memberNames);

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
          const { normalizeName: normalizeNameForLookup } = await import('./nameNormalization');
          const detailData = memberDetailsMap.get(normalizeNameForLookup(member.name));
          
          // Merge detail page data
          let finalTitle = member.title;
          let finalLinkedinUrl = linkedinUrl;
          let finalSpecialization = member.specialization;
          
          if (detailData) {
            // Prefer title from detail page if available and not empty
            if (detailData.title && detailData.title.trim().length > 0) {
              finalTitle = detailData.title;
              console.log(`[extractTeamMembers] Using profile title for ${member.name}: "${finalTitle}"`);
            }
            
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
          
          // Get email from multiple sources: detail page first, then main page extraction
          const detailEmail = detailData?.email || "";
          const mainPageEmail = mainPageEmails.get(member.name) || "";
          const finalEmail = detailEmail || mainPageEmail;
          
          return {
            name: member.name,
            title: finalTitle,
            jobFunction: member.job_function,
            specialization: finalSpecialization,
            linkedinUrl: finalLinkedinUrl,
            email: finalEmail,
            portfolioCompanies: detailData?.portfolioCompanies?.join(", ") || "",
            investmentFocus: detailData?.investmentFocus || member.investmentFocus || "",
            stagePreference: detailData?.stagePreference || member.stagePreference || "",
            checkSizeRange: detailData?.checkSizeRange || member.checkSizeRange || "",
            geographicFocus: detailData?.geographicFocus || member.geographicFocus || "",
            investmentThesis: detailData?.investmentThesis || member.investmentThesis || "",
            notableInvestments: detailData?.notableInvestments?.join(", ") || (Array.isArray(member.notableInvestments) ? member.notableInvestments.join(", ") : ""),
            yearsExperience: detailData?.yearsExperience || member.yearsExperience || "",
            background: detailData?.background || member.background || "",
            dataSourceUrl: teamUrl,
            confidenceScore,
          };
        })
      );
      
      // Log data quality metrics
      const linkedinCount = enrichedMembers.filter(m => m.linkedinUrl && m.linkedinUrl.length > 0).length;
      const specializationCount = enrichedMembers.filter(m => m.specialization && m.specialization.length > 0).length;
      const emailCount = enrichedMembers.filter(m => m.email && m.email.length > 0).length;
      
      console.log(`[extractTeamMembers] Final enriched members: ${enrichedMembers.length}`);
      console.log(`[extractTeamMembers] Data quality metrics:`);
      console.log(`[extractTeamMembers]   - LinkedIn URLs: ${linkedinCount}/${enrichedMembers.length} (${Math.round(linkedinCount / enrichedMembers.length * 100)}%)`);
      console.log(`[extractTeamMembers]   - Specializations: ${specializationCount}/${enrichedMembers.length} (${Math.round(specializationCount / enrichedMembers.length * 100)}%)`);
      console.log(`[extractTeamMembers]   - Emails: ${emailCount}/${enrichedMembers.length} (${Math.round(emailCount / enrichedMembers.length * 100)}%)`);
      console.log(`========================================\n`);
      return enrichedMembers;
    } catch (error) {
      console.error("[extractTeamMembers] ✗ Error:", error);
      console.log(`========================================\n`);
      return [];
    }
  }

  async extractPortfolioCompanies(
    url: string,
    companyName: string,
    multiPageResult?: ComprehensiveScrapingResult
  ): Promise<PortfolioCompany[]> {
    const { 
      getPortfolioUrlPatterns, 
      extractPortfolioFromHTML, 
      enrichPortfolioCandidates,
      extractPortfolioWithLLM 
    } = await import('./portfolioExtractor');
    
    console.log(`[extractPortfolioCompanies] Starting for: ${companyName}`);
    console.log(`[extractPortfolioCompanies] Base URL: ${url}`);
    
    let html: string | null = null;
    let portfolioUrl = url;
    
    // If multi-page result is provided, use aggregated portfolio content
    if (multiPageResult) {
      console.log(`[extractPortfolioCompanies] Using multi-page scraping result`);
      html = getPortfolioSpecificContent(multiPageResult);
      portfolioUrl = url;
      console.log(`[extractPortfolioCompanies] Aggregated content from ${multiPageResult.stats.portfolioPagesScraped + 1} pages`);
      console.log(`[extractPortfolioCompanies] Total content length: ${html.length} characters`);
    } else {
      // Fallback to old method if no multi-page result
      console.log(`[extractPortfolioCompanies] No multi-page result, using legacy method`);
      
      // Try comprehensive portfolio page URLs
      const portfolioUrls = getPortfolioUrlPatterns(url);

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
          console.log(`[extractPortfolioCompanies] \u2713 Found portfolio page at: ${portfolioUrl}`);
          break;
        }
      }

      if (!html) {
        console.log(`[extractPortfolioCompanies] \u2717 No portfolio page found`);
        return [];
      }

      console.log(`[extractPortfolioCompanies] Using portfolio URL: ${portfolioUrl}`);
      console.log(`[extractPortfolioCompanies] HTML length: ${html.length} characters`);
    }

    console.log(`[extractPortfolioCompanies] ===== STARTING PORTFOLIO EXTRACTION =====`);
    console.log(`[extractPortfolioCompanies] HTML length: ${html.length} chars`);
    console.log(`[extractPortfolioCompanies] Portfolio URL: ${portfolioUrl}`);
    
    try {
      // Strategy 1: HTML parsing to extract links and images
      console.log(`[extractPortfolioCompanies] Trying HTML parsing strategy...`);
      const candidates = extractPortfolioFromHTML(html, portfolioUrl);
      console.log(`[extractPortfolioCompanies] HTML parsing found ${candidates.length} candidates`);
      
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
      console.log(`[extractPortfolioCompanies] Extracted text length: ${text.length} chars`);
      console.log(`[extractPortfolioCompanies] First 300 chars: ${text.substring(0, 300)}`);
      
      const companies = await extractPortfolioWithLLM(text, portfolioUrl, companyName);
      console.log(`[extractPortfolioCompanies] LLM extraction returned ${companies.length} companies`);
      
      if (companies.length === 0) {
        console.warn(`[extractPortfolioCompanies] ⚠️ WARNING: 0 portfolio companies extracted!`);
        console.warn(`[extractPortfolioCompanies] Text sample: ${text.substring(0, 500)}`);
      }
      
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
    options: {
      deepTeamProfileScraping?: boolean;
      maxTeamProfiles?: number;
      useIterativeExtraction?: boolean;
      maxIterations?: number;
      useRecursiveScraping?: boolean;
      maxRecursiveDepth?: number;
      maxRecursivePages?: number;
    } = {}
  ): Promise<EnrichmentResult> {
    const { 
      deepTeamProfileScraping = true, 
      maxTeamProfiles = 200,
      useIterativeExtraction = false,
      maxIterations = 5,
      useRecursiveScraping = true, // NEW: Enable by default
      maxRecursiveDepth = 3,
      maxRecursivePages = 20
    } = options;
    try {
      // Normalize URL to fix common issues (missing protocol, trailing slash, etc.)
      websiteUrl = normalizeUrl(websiteUrl);
      
      console.log(`\n${'='.repeat(80)}`);
      console.log(`[enrichVCFirm] 🚀 Starting enrichment for: ${companyName}`);
      console.log(`[enrichVCFirm] 🌐 Website: ${websiteUrl}`);
      console.log(`${'='.repeat(80)}\n`);
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

    // Step 1: Choose extraction strategy
    if (useIterativeExtraction) {
      // Use new iterative LLM-guided extraction
      console.log(`[enrichVCFirm] 🤖 Using iterative LLM-guided extraction`);
      onProgress?.(`Using intelligent iterative extraction for ${companyName}`);
      
      const { runIterativeExtraction } = await import('./iterativeExtraction');
      const iterativeResult = await runIterativeExtraction(
        companyName,
        websiteUrl,
        {
          maxIterations,
          onProgress,
        }
      );
      
      console.log(`[enrichVCFirm] 📊 Iterative extraction results:`);
      console.log(`  - Iterations completed: ${iterativeResult.iteration}`);
      console.log(`  - URLs scraped: ${iterativeResult.scrapedUrls.length}`);
      console.log(`  - Team members: ${iterativeResult.teamMembers.length}`);
      console.log(`  - Portfolio companies: ${iterativeResult.portfolioCompanies.length}`);
      
      // Map iterative results to enrichment result format
      result.investorType = iterativeResult.investorType;
      result.investorTypeConfidence = iterativeResult.investorType.length > 0 ? "High" : "Low";
      result.investmentStages = iterativeResult.investmentStages;
      result.investmentStagesConfidence = iterativeResult.investmentStages.length > 0 ? "High" : "Low";
      result.investmentNiches = iterativeResult.investmentNiches;
      result.nichesConfidence = iterativeResult.investmentNiches.length > 0 ? "High" : "Low";
      result.teamMembers = iterativeResult.teamMembers.map((m: any) => ({
        name: m.name,
        title: m.title || "",
        jobFunction: "",
        specialization: "",
        linkedinUrl: m.linkedinUrl || "",
        email: m.email || "",
        portfolioCompanies: m.portfolioCompanies || "",
        investmentFocus: m.investmentFocus || "",
        stagePreference: m.stagePreference || "",
        checkSizeRange: m.checkSizeRange || "",
        geographicFocus: m.geographicFocus || "",
        investmentThesis: m.investmentThesis || "",
        notableInvestments: Array.isArray(m.notableInvestments) ? m.notableInvestments.join(", ") : (m.notableInvestments || ""),
        yearsExperience: m.yearsExperience || "",
        background: m.background || "",
        dataSourceUrl: websiteUrl,
        confidenceScore: m.linkedinUrl ? "High" : "Low",
      }));
      result.portfolioCompanies = iterativeResult.portfolioCompanies.map((p: any) => ({
        companyName: p.companyName,
        investmentDate: "",
        websiteUrl: p.websiteUrl || "",
        investmentNiche: p.investmentNiche || [],
        dataSourceUrl: websiteUrl,
        confidenceScore: "Medium",
      }));
      
      // Skip to verification and return
      onProgress?.(`Verifying website for ${companyName}`);
      const verification = await this.verifyWebsite(websiteUrl, companyName, description);
      result.websiteVerified = verification.verified;
      result.verificationMessage = verification.message;
      
      onProgress?.(`Completed iterative extraction for ${companyName}`);
      console.log(`[enrichVCFirm] ✅ Iterative extraction completed for ${companyName}\n`);
      
      return result;
    }
    
    // NEW: Use LLM-driven recursive scraping (default)
    if (useRecursiveScraping) {
      console.log(`[enrichVCFirm] 🤖 Using LLM-driven recursive scraping`);
      onProgress?.(`Using intelligent recursive scraping for ${companyName}`);
      
      const recursiveResult = await scrapeRecursively(
        companyName,
        websiteUrl,
        this.fetchWebpage.bind(this),
        {
          maxDepth: maxRecursiveDepth,
          maxPages: maxRecursivePages,
          maxProfilePages: maxTeamProfiles,
          delayBetweenPages: 1000,
          goal: 'all',
          enableDeepProfiles: deepTeamProfileScraping,
          profile: this.profile,
          onProgress: (msg, stats) => {
            onProgress?.(`${msg} (${stats.teamMembersFound} team, ${stats.portfolioCompaniesFound} portfolio)`);
          }
        }
      );
      
      console.log(`[enrichVCFirm] 📊 Recursive scraping stats:`);
      console.log(`  - Total pages visited: ${recursiveResult.stats.totalPagesVisited}`);
      console.log(`  - Team pages: ${recursiveResult.stats.teamPagesVisited}`);
      console.log(`  - Profile pages: ${recursiveResult.stats.profilePagesVisited}`);
      console.log(`  - Portfolio pages: ${recursiveResult.stats.portfolioPagesVisited}`);
      console.log(`  - Team members found: ${recursiveResult.teamMembers.length}`);
      console.log(`  - Portfolio companies found: ${recursiveResult.portfolioCompanies.length}`);
      
      // Verify website
      onProgress?.(`Verifying website for ${companyName}`);
      const verification = await this.verifyWebsite(websiteUrl, companyName, description);
      result.websiteVerified = verification.verified;
      result.verificationMessage = verification.message;
      
      // Extract investor type, stages, niches from firm description or homepage
      if (recursiveResult.firmDescription) {
        onProgress?.(`Analyzing firm characteristics for ${companyName}`);
        const investorTypeData = await this.extractInvestorType(websiteUrl, companyName, recursiveResult.firmDescription);
        result.investorType = investorTypeData.types;
        result.investorTypeConfidence = investorTypeData.confidence;
        result.investorTypeSourceUrl = investorTypeData.sourceUrl;
        
        const stagesData = await this.extractInvestmentStages(websiteUrl, companyName, recursiveResult.firmDescription);
        result.investmentStages = stagesData.stages;
        result.investmentStagesConfidence = stagesData.confidence;
        result.investmentStagesSourceUrl = stagesData.sourceUrl;
        
        const nichesData = await this.extractInvestmentNiches(websiteUrl, companyName);
        result.investmentNiches = nichesData.niches;
        result.nichesConfidence = nichesData.confidence;
        result.nichesSourceUrl = nichesData.sourceUrl;
      }
      
      // Map recursive results to enrichment result format
      result.teamMembers = recursiveResult.teamMembers.map(m => ({
        name: m.name,
        title: m.title || '',
        jobFunction: m.jobFunction || '',
        specialization: m.specialization || '',
        linkedinUrl: m.linkedinUrl || '',
        email: m.email || '',
        portfolioCompanies: (m.portfolioCompanies || []).join(', '),
        investmentFocus: m.investmentFocus || '',
        stagePreference: m.stagePreference || '',
        checkSizeRange: m.checkSizeRange || '',
        geographicFocus: m.geographicFocus || '',
        investmentThesis: m.investmentThesis || '',
        notableInvestments: (m.notableInvestments || []).join(', '),
        yearsExperience: m.yearsExperience || '',
        background: m.background || '',
        dataSourceUrl: m.profileUrl || websiteUrl,
        confidenceScore: m.linkedinUrl ? 'High' : (m.email ? 'Medium' : 'Low'),
      }));
      
      result.portfolioCompanies = recursiveResult.portfolioCompanies.map(p => ({
        companyName: p.name,
        investmentDate: '',
        websiteUrl: p.url || '',
        investmentNiche: p.sector ? [p.sector] : [],
        dataSourceUrl: websiteUrl,
        confidenceScore: 'Medium',
      }));
      
      // Log any errors
      if (recursiveResult.errors.length > 0) {
        console.warn(`[enrichVCFirm] ⚠️ Recursive scraping had ${recursiveResult.errors.length} errors:`);
        recursiveResult.errors.slice(0, 5).forEach(e => console.warn(`  - ${e}`));
      }
      
      onProgress?.(`Completed recursive scraping for ${companyName}`);
      console.log(`[enrichVCFirm] ✅ Recursive scraping completed for ${companyName}\n`);
      
      return result;
    }
    
    // FALLBACK: Use traditional comprehensive multi-page scraping
    onProgress?.(`Discovering and scraping all relevant pages for ${companyName}`);
    console.log(`[enrichVCFirm] 🔍 Starting comprehensive multi-page scraping (fallback)`);
    
    const multiPageResult = await scrapeComprehensively(
      companyName,
      websiteUrl,
      this.fetchWebpage.bind(this),
      {
        maxTeamPages: 5,
        maxPortfolioPages: 3,
        maxAboutPages: 2,
        delayBetweenPages: 1000,
      }
    );
    
    console.log(`[enrichVCFirm] 📊 Multi-page scraping stats:`);
    console.log(`  - Total pages discovered: ${multiPageResult.stats.totalPagesDiscovered}`);
    console.log(`  - Successful scrapes: ${multiPageResult.stats.successfulScrapes}`);
    console.log(`  - Team pages: ${multiPageResult.stats.teamPagesScraped}`);
    console.log(`  - Portfolio pages: ${multiPageResult.stats.portfolioPagesScraped}`);
    console.log(`  - About pages: ${multiPageResult.stats.aboutPagesScraped}`);
    
    // Step 2: Verify website
    onProgress?.(`Verifying website for ${companyName}`);
    const verification = await this.verifyWebsite(websiteUrl, companyName, description);
    result.websiteVerified = verification.verified;
    result.verificationMessage = verification.message;
    
    if (verification.verified) {
      console.log(`[enrichVCFirm] ✅ Website verified successfully`);
    } else {
      console.warn(`[enrichVCFirm] ❌ Website verification failed: ${verification.message}`);
    }

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

    // Step 5: Extract team members (using multi-page content + optional deep profile scraping)
    onProgress?.(`Extracting team members for ${companyName}`);
    if (deepTeamProfileScraping) {
      onProgress?.(`Deep scraping enabled: Following individual profile links (may take longer)`);
    }
    result.teamMembers = await this.extractTeamMembers(
      websiteUrl,
      companyName,
      multiPageResult,
      {
        deepProfileScraping: deepTeamProfileScraping,
        maxProfiles: maxTeamProfiles,
      }
    );
    console.log(`[enrichVCFirm] 👥 Extracted ${result.teamMembers.length} team members`);
    if (deepTeamProfileScraping) {
      console.log(`[enrichVCFirm] 🔍 Deep profile scraping was enabled`);
    }

    // Step 6: Extract portfolio companies (using multi-page content)
    onProgress?.(`Extracting portfolio companies for ${companyName}`);
    result.portfolioCompanies = await this.extractPortfolioCompanies(websiteUrl, companyName, multiPageResult);
    console.log(`[enrichVCFirm] 💼 Extracted ${result.portfolioCompanies.length} portfolio companies`);

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

    // Enrich all members (no limit)
    const membersToEnrich = result.teamMembers;
    
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
    console.log(`[enrichVCFirm] ✅ Enrichment completed for ${companyName}\n`);

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
