/**
 * Comprehensive Portfolio Company Extractor
 * Handles text-based, logo-based, and mixed portfolio pages
 */
import * as cheerio from "cheerio";
import { queuedLLMCall } from "./_core/llmQueue";

export interface PortfolioCompany {
  companyName: string;
  websiteUrl: string;
  investmentDate: string;
  investmentStage: string;
  sector: string;
  investmentNiche: string[]; // For compatibility with vcEnrichment.ts
  dataSourceUrl: string;
  confidenceScore: string;
  extractionMethod: string; // "html_parsing" | "llm_text" | "llm_vision"
}

interface PortfolioCandidate {
  name: string;
  websiteUrl: string;
  context: string; // Surrounding text for LLM enrichment
}

/**
 * Comprehensive list of portfolio page URL patterns
 */
export function getPortfolioUrlPatterns(baseUrl: string): string[] {
  return [
    // Standard patterns
    `${baseUrl}/portfolio`,
    `${baseUrl}/companies`,
    `${baseUrl}/investments`,
    `${baseUrl}/portfolio-companies`,
    
    // Alternative naming
    `${baseUrl}/our-companies`,
    `${baseUrl}/our-investments`,
    `${baseUrl}/our-portfolio`,
    `${baseUrl}/ventures`,
    `${baseUrl}/current-holdings`,
    `${baseUrl}/direct-investments`,
    `${baseUrl}/featured`,
    `${baseUrl}/portfolio-co`,
    
    // Variations
    `${baseUrl}/what-we-do`,
    `${baseUrl}/investment-portfolio`,
    `${baseUrl}/fund-investments`,
    `${baseUrl}/our-ventures`,
    
    // Homepage last (fallback)
    baseUrl
  ];
}

/**
 * Extract portfolio companies from HTML using structure parsing
 * Handles logo-based and link-based portfolios
 */
export function extractPortfolioFromHTML(html: string, pageUrl: string): PortfolioCandidate[] {
  const $ = cheerio.load(html);
  const candidates: PortfolioCandidate[] = [];
  const seenUrls = new Set<string>();

  console.log(`[Portfolio HTML] Parsing HTML from ${pageUrl}`);

  // Strategy 1: Find portfolio sections by heading keywords
  const portfolioKeywords = [
    'portfolio', 'companies', 'investments', 'holdings', 'ventures',
    'our companies', 'our investments', 'direct investments', 'featured companies'
  ];

  let portfolioSection: cheerio.Cheerio<any> | null = null;

  // Look for headings containing portfolio keywords
  $('h1, h2, h3, h4').each((_: number, elem: any) => {
    const headingText = $(elem).text().toLowerCase();
    if (portfolioKeywords.some(kw => headingText.includes(kw))) {
      console.log(`[Portfolio HTML] Found portfolio heading: "${$(elem).text()}"`);
      // Get the section containing this heading
      portfolioSection = $(elem).parent();
      return false; // break
    }
  });

  // If no specific section found, search entire page
  if (!portfolioSection) {
    console.log(`[Portfolio HTML] No specific portfolio section found, searching entire page`);
    portfolioSection = $('body');
  }

  // Strategy 2: Extract company names from logo images (for A16z-style pages)
  portfolioSection.find('img').each((_, elem) => {
    const $img = $(elem);
    const alt = $img.attr('alt');
    const src = $img.attr('src');
    
    // Try to get company name from alt text
    let companyName = '';
    if (alt && alt.length > 0 && alt.length < 100 && !alt.toLowerCase().includes('logo')) {
      companyName = alt.trim();
    }
    
    // Try to get from filename if alt is not useful
    if (!companyName && src) {
      const filename = src.split('/').pop()?.split('.')[0] || '';
      if (filename && filename.length > 2 && !filename.includes('logo') && !filename.includes('icon')) {
        companyName = filename.replace(/[-_]/g, ' ');
      }
    }
    
    if (companyName) {
      // Get surrounding context
      const context = $img.closest('div, article, section').text().trim().substring(0, 500);
      
      // Check if we already have this company
      const existing = candidates.find(c => c.name.toLowerCase() === companyName.toLowerCase());
      if (!existing) {
        candidates.push({
          name: companyName,
          websiteUrl: '', // Will be enriched by LLM
          context
        });
        console.log(`[Portfolio HTML] Found company from image: ${companyName}`);
      }
    }
  });
  
  // Strategy 3: Extract from links in portfolio section
  portfolioSection.find('a').each((_, elem) => {
    const $link = $(elem);
    const href = $link.attr('href');
    
    if (!href) return;

    // Skip internal links, social media, and common non-portfolio links
    if (
      href.startsWith('#') ||
      href.startsWith('/') ||
      href.includes('twitter.com') ||
      href.includes('linkedin.com') ||
      href.includes('facebook.com') ||
      href.includes('instagram.com') ||
      href.includes('youtube.com') ||
      href.includes('mailto:') ||
      href.includes('/jobs') ||
      href.includes('jobs.') ||
      href.includes('careers.') ||
      href.includes('/careers')
    ) {
      return;
    }

    // External link = potential portfolio company
    try {
      const linkUrl = new URL(href);
      const baseDomain = new URL(pageUrl).hostname;
      
      // Skip if same domain as VC firm
      if (linkUrl.hostname === baseDomain) return;
      
      // Skip if already seen
      if (seenUrls.has(linkUrl.origin)) return;
      seenUrls.add(linkUrl.origin);

      // Extract company name from link text, image alt, or domain
      let companyName = '';
      
      // Try link text
      const linkText = $link.text().trim();
      if (linkText && linkText.length > 0 && linkText.length < 100) {
        companyName = linkText;
      }
      
      // Try image alt text
      if (!companyName) {
        const $img = $link.find('img');
        if ($img.length > 0) {
          const alt = $img.attr('alt');
          if (alt && alt.length > 0 && alt.length < 100) {
            companyName = alt;
          }
        }
      }
      
      // Try image filename
      if (!companyName) {
        const $img = $link.find('img');
        if ($img.length > 0) {
          const src = $img.attr('src');
          if (src) {
            const filename = src.split('/').pop()?.split('.')[0] || '';
            if (filename && filename.length > 2) {
              companyName = filename.replace(/[-_]/g, ' ');
            }
          }
        }
      }
      
      // Fallback: use domain name
      if (!companyName) {
        companyName = linkUrl.hostname.replace('www.', '').split('.')[0];
      }

      // Get surrounding context for LLM enrichment
      const context = $link.parent().text().trim().substring(0, 500);

      candidates.push({
        name: companyName,
        websiteUrl: linkUrl.origin,
        context
      });

      console.log(`[Portfolio HTML] Found candidate: ${companyName} -> ${linkUrl.origin}`);
    } catch (e) {
      // Invalid URL, skip
    }
  });

  console.log(`[Portfolio HTML] Extracted ${candidates.length} candidates from HTML`);
  return candidates;
}

/**
 * Enrich portfolio candidates with LLM to extract additional details
 */
export async function enrichPortfolioCandidates(
  candidates: PortfolioCandidate[],
  fullPageText: string,
  vcFirmName: string
): Promise<PortfolioCompany[]> {
  if (candidates.length === 0) {
    console.log(`[Portfolio Enrich] No candidates from HTML parsing, will use LLM fallback`);
    return [];
  }

  console.log(`[Portfolio Enrich] Enriching ${candidates.length} candidates for ${vcFirmName}`);

  // If candidates list is small, process all at once
  if (candidates.length <= 20) {
    console.log(`[Portfolio Enrich] Small list (${candidates.length}), single pass`);
    return enrichPortfolioChunk(candidates, fullPageText, vcFirmName);
  }

  // For large lists, use chunking to avoid output token limits
  const CHUNK_SIZE = 20;
  const allEnriched: PortfolioCompany[] = [];
  
  console.log(`[Portfolio Enrich] Large list (${candidates.length}), using ${Math.ceil(candidates.length / CHUNK_SIZE)} chunks`);
  
  for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + CHUNK_SIZE);
    console.log(`[Portfolio Enrich] Processing chunk ${Math.floor(i / CHUNK_SIZE) + 1}: ${chunk.length} companies`);
    
    const enriched = await enrichPortfolioChunk(chunk, fullPageText, vcFirmName);
    allEnriched.push(...enriched);
    
    console.log(`[Portfolio Enrich] Total enriched so far: ${allEnriched.length}`);
  }

  console.log(`[Portfolio Enrich] Final total: ${allEnriched.length} companies`);
  return allEnriched;
}

/**
 * Enrich a chunk of portfolio candidates (max 20 at a time)
 */
async function enrichPortfolioChunk(
  candidates: PortfolioCandidate[],
  fullPageText: string,
  vcFirmName: string
): Promise<PortfolioCompany[]> {
  // Build prompt with candidates in this chunk
  const candidateList = candidates
    .map((c, idx) => `${idx + 1}. ${c.name} (${c.websiteUrl})`)
    .join('\n');

  const prompt = `You are analyzing portfolio companies for a venture capital firm.

VC Firm: ${vcFirmName}

Portfolio companies found:
${candidateList}

Page context (first 16000 chars):
${fullPageText.substring(0, 16000)}

For each portfolio company listed above, extract:
1. Company name (clean, proper formatting)
2. Website URL (as provided)
3. Investment date (YYYY-MM-DD, YYYY-MM, YYYY, or "Unknown")
4. Investment stage (Seed, Series A, Series B, etc., or "Unknown")
5. Sector/industry (e.g., "Fintech", "Healthcare", "SaaS", or "Unknown")

IMPORTANT: Return ALL companies as a JSON array. Do not filter or limit the results.
You MUST extract at least 10 companies if they are available on the page.
If you see more than 20 companies, extract all of them - do not stop at 5 or 10.

Example format:
{
  "companies": [
    {
      "company_name": "Acme Corp",
      "website_url": "https://acme.com",
      "investment_date": "2024-03",
      "investment_stage": "Series A",
      "sector": "Fintech"
    }
  ]
}`;

  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "portfolio_enrichment",
          strict: true,
          schema: {
            type: "object",
            properties: {
              companies: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    company_name: { type: "string" },
                    website_url: { type: "string" },
                    investment_date: { type: "string" },
                    investment_stage: { type: "string" },
                    sector: { type: "string" },
                  },
                  required: ["company_name", "website_url", "investment_date", "investment_stage", "sector"],
                  additionalProperties: false,
                },
              },
            },
            required: ["companies"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    const result = JSON.parse(typeof content === 'string' ? content : '{}');
    const enriched = result.companies || [];

    console.log(`[Portfolio Enrich] LLM enriched ${enriched.length} companies`);

    return enriched.map((company: any) => ({
      companyName: company.company_name,
      websiteUrl: company.website_url,
      investmentDate: company.investment_date,
      investmentStage: company.investment_stage,
      sector: company.sector,
      dataSourceUrl: "",
      confidenceScore: "High",
      extractionMethod: "html_parsing",
      investmentNiche: company.sector ? [company.sector] : [],
    }));
  } catch (error) {
    console.error("[Portfolio Enrich] Error enriching candidates:", error);
    
    // Fallback: return candidates as-is with minimal data
    return candidates.map(c => ({
      companyName: c.name,
      websiteUrl: c.websiteUrl,
      investmentDate: "Unknown",
      investmentStage: "Unknown",
      sector: "Unknown",
      dataSourceUrl: "",
      confidenceScore: "Medium",
      extractionMethod: "html_parsing",
      investmentNiche: [],
    }));
  }
}

/**
 * Fallback: Extract portfolio using pure LLM text analysis
 * Used when HTML parsing finds nothing
 */
export async function extractPortfolioWithLLM(
  pageText: string,
  pageUrl: string,
  vcFirmName: string
): Promise<PortfolioCompany[]> {
  console.log(`[Portfolio LLM] Using pure LLM extraction for ${vcFirmName}`);

  const prompt = `You are analyzing a venture capital firm's portfolio page to extract information about their investments.

VC Firm: ${vcFirmName}
Portfolio Page URL: ${pageUrl}

Page Content (first 20000 chars):
${pageText.substring(0, 20000)}

Extract information about ALL portfolio companies mentioned on this page. For each company, provide:
1. Company name
2. Company website URL (if available, otherwise leave empty)
3. Investment date (YYYY-MM-DD, YYYY-MM, YYYY, or "Unknown")
4. Investment stage (Seed, Series A, Series B, etc., or "Unknown")
5. Sector/industry (e.g., "Fintech", "Healthcare", "SaaS", or "Unknown")

IMPORTANT: Return ALL companies found. Do not limit to 5 or any specific number.
You MUST extract at least 10 companies if they are available on the page.
If you see 50+ companies, extract all of them - do not stop at 5, 10, or 20.

Example format:
{
  "companies": [
    {"company_name": "Acme Corp", "website_url": "https://acme.com", "investment_date": "2024-03-15", "investment_stage": "Series A", "sector": "Fintech"},
    {"company_name": "TechStart", "website_url": "", "investment_date": "2024", "investment_stage": "Seed", "sector": "SaaS"}
  ]
}`;

  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "portfolio_companies",
          strict: true,
          schema: {
            type: "object",
            properties: {
              companies: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    company_name: { type: "string" },
                    website_url: { type: "string" },
                    investment_date: { type: "string" },
                    investment_stage: { type: "string" },
                    sector: { type: "string" },
                  },
                  required: ["company_name", "website_url", "investment_date", "investment_stage", "sector"],
                  additionalProperties: false,
                },
              },
            },
            required: ["companies"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    const result = JSON.parse(typeof content === 'string' ? content : '{}');
    const companies = result.companies || [];

    console.log(`[Portfolio LLM] Extracted ${companies.length} companies via pure LLM`);

    return companies.map((company: any) => ({
      companyName: company.company_name,
      websiteUrl: company.website_url,
      investmentDate: company.investment_date,
      investmentStage: company.investment_stage,
      sector: company.sector,
      dataSourceUrl: pageUrl,
      confidenceScore: "Medium",
      extractionMethod: "llm_text",
      investmentNiche: company.sector ? [company.sector] : [],
    }));
  } catch (error) {
    console.error("[Portfolio LLM] Error extracting with LLM:", error);
    return [];
  }
}
