/**
 * SEC EDGAR Integration
 * 
 * Provides access to SEC filings for US-based VC firms:
 * - Form D: Private placement offerings (fundraising)
 * - Form ADV: Investment adviser registrations (strategy, focus)
 * 
 * All data is free and publicly available.
 */

import axios from "axios";
import * as cheerio from "cheerio";

interface SECFiling {
  companyName: string;
  cik: string;
  filingType: string;
  filingDate: string;
  documentUrl: string;
}

interface InvestmentStrategy {
  description: string;
  investmentTypes: string[];
  assetClasses: string[];
  confidenceScore: "High" | "Medium" | "Low";
  sourceUrl: string;
}

/**
 * Search for SEC filings by company name
 */
export async function searchSECFilings(companyName: string): Promise<SECFiling[]> {
  try {
    // SEC EDGAR Company Search API
    const searchUrl = `https://www.sec.gov/cgi-bin/browse-edgar`;
    
    const response = await axios.get(searchUrl, {
      params: {
        action: "getcompany",
        company: companyName,
        type: "D", // Form D filings
        dateb: "", // All dates
        owner: "exclude",
        count: 10,
      },
      headers: {
        "User-Agent": "VC Enrichment Tool contact@example.com", // Required by SEC
        "Accept": "text/html",
      },
      timeout: 10000,
    });

    const $ = cheerio.load(response.data);
    const filings: SECFiling[] = [];

    // Parse filing table
    $("#seriesDiv table.tableFile2 tr").each((index, row) => {
      if (index === 0) return; // Skip header

      const cells = $(row).find("td");
      if (cells.length < 4) return;

      const filingType = $(cells[0]).text().trim();
      const filingDate = $(cells[3]).text().trim();
      const documentLink = $(cells[1]).find("a").attr("href");

      if (documentLink) {
        filings.push({
          companyName,
          cik: "", // Will be extracted from document
          filingType,
          filingDate,
          documentUrl: `https://www.sec.gov${documentLink}`,
        });
      }
    });

    return filings;
  } catch (error) {
    console.error(`[SEC EDGAR] Error searching for ${companyName}:`, error);
    return [];
  }
}

/**
 * Extract investment strategy from Form ADV
 */
export async function extractInvestmentStrategyFromFormADV(
  documentUrl: string
): Promise<InvestmentStrategy | null> {
  try {
    const response = await axios.get(documentUrl, {
      headers: {
        "User-Agent": "VC Enrichment Tool contact@example.com",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);
    const text = $.text();

    // Extract investment strategy keywords
    const investmentTypes: string[] = [];
    const assetClasses: string[] = [];

    // Common VC-related keywords in Form ADV
    const vcKeywords = [
      "venture capital",
      "early stage",
      "seed stage",
      "growth equity",
      "private equity",
      "angel investment",
    ];

    const assetKeywords = [
      "technology",
      "healthcare",
      "fintech",
      "saas",
      "biotech",
      "consumer",
      "enterprise software",
    ];

    // Search for keywords in the document
    vcKeywords.forEach((keyword) => {
      if (text.toLowerCase().includes(keyword)) {
        investmentTypes.push(keyword);
      }
    });

    assetKeywords.forEach((keyword) => {
      if (text.toLowerCase().includes(keyword)) {
        assetClasses.push(keyword);
      }
    });

    // Extract strategy description (look for specific sections)
    let description = "";
    const strategyMatch = text.match(
      /investment strategy[:\s]+([^.]{50,500})/i
    );
    if (strategyMatch) {
      description = strategyMatch[1].trim();
    }

    if (investmentTypes.length === 0 && assetClasses.length === 0) {
      return null;
    }

    return {
      description: description || "Investment strategy found in SEC filings",
      investmentTypes,
      assetClasses,
      confidenceScore: description ? "High" : "Medium",
      sourceUrl: documentUrl,
    };
  } catch (error) {
    console.error("[SEC EDGAR] Error extracting strategy:", error);
    return null;
  }
}

/**
 * Get investment data for a VC firm from SEC EDGAR
 */
export async function getVCFirmSECData(companyName: string): Promise<{
  hasFilings: boolean;
  investmentStrategy: InvestmentStrategy | null;
  filings: SECFiling[];
}> {
  const filings = await searchSECFilings(companyName);

  if (filings.length === 0) {
    return {
      hasFilings: false,
      investmentStrategy: null,
      filings: [],
    };
  }

  // Try to extract strategy from most recent Form ADV
  let investmentStrategy: InvestmentStrategy | null = null;
  
  // Look for Form ADV filings (investment adviser registration)
  const advFilings = filings.filter(f => f.filingType.includes("ADV"));
  if (advFilings.length > 0) {
    investmentStrategy = await extractInvestmentStrategyFromFormADV(
      advFilings[0].documentUrl
    );
  }

  return {
    hasFilings: true,
    investmentStrategy,
    filings,
  };
}
