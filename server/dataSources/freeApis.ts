/**
 * Free API integrations for VC enrichment
 * Includes Crunchbase Basic, LinkedIn Company API, and other free data sources
 */

import { callDataApi } from "../_core/dataApi";
import axios from "axios";

export interface CrunchbaseCompanyData {
  name: string;
  description?: string;
  foundedYear?: number;
  fundingTotal?: number;
  fundingRounds?: number;
  lastFundingDate?: string;
  lastFundingType?: string;
  investorCount?: number;
  website?: string;
  confidence: "High" | "Medium" | "Low";
  sourceUrl: string;
}

export interface LinkedInCompanyData {
  name: string;
  description?: string;
  website?: string;
  staffCount?: number;
  followerCount?: number;
  industries?: string[];
  specialities?: string[];
  crunchbaseUrl?: string;
  confidence: "High" | "Medium" | "Low";
  sourceUrl: string;
}

/**
 * Get company details from LinkedIn using Manus Data API
 */
export async function getLinkedInCompanyData(companyName: string): Promise<LinkedInCompanyData | null> {
  try {
    // Extract username from company name (convert to lowercase, replace spaces with hyphens)
    const username = companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    
    const response = await callDataApi("LinkedIn/get_company_details", {
      query: { username },
    }) as any;

    if (!response?.success || !response?.data) {
      return null;
    }

    const data = response.data;

    return {
      name: data.name || companyName,
      description: data.description,
      website: data.website,
      staffCount: data.staffCount,
      followerCount: data.followerCount,
      industries: data.industries || [],
      specialities: data.specialities || [],
      crunchbaseUrl: data.crunchbaseUrl,
      confidence: "High",
      sourceUrl: data.linkedinUrl || `https://linkedin.com/company/${username}`,
    };
  } catch (error) {
    console.error(`Error fetching LinkedIn data for ${companyName}:`, error);
    return null;
  }
}

/**
 * Get company data from Crunchbase (free tier - limited to basic info)
 * Note: Crunchbase Basic API is limited. For production, consider upgrading to paid tier.
 */
export async function getCrunchbaseData(companyName: string, websiteUrl?: string): Promise<CrunchbaseCompanyData | null> {
  try {
    // Try to get Crunchbase URL from LinkedIn first
    const linkedInData = await getLinkedInCompanyData(companyName);
    
    if (linkedInData?.crunchbaseUrl) {
      // We have a Crunchbase URL, but can't access full data without paid API
      // Return basic info we can extract from the URL
      const orgId = linkedInData.crunchbaseUrl.split("/").pop();
      
      return {
        name: companyName,
        description: linkedInData.description,
        website: linkedInData.website || websiteUrl,
        confidence: "Medium",
        sourceUrl: linkedInData.crunchbaseUrl,
      };
    }

    return null;
  } catch (error) {
    console.error(`Error fetching Crunchbase data for ${companyName}:`, error);
    return null;
  }
}

/**
 * Get company data from OpenCorporates (free API for company registration data)
 */
export async function getOpenCorporatesData(companyName: string): Promise<{
  jurisdiction?: string;
  companyNumber?: string;
  incorporationDate?: string;
  companyType?: string;
  status?: string;
  confidence: "High" | "Medium" | "Low";
  sourceUrl: string;
} | null> {
  try {
    // OpenCorporates free API endpoint
    const response = await axios.get(`https://api.opencorporates.com/v0.4/companies/search`, {
      params: {
        q: companyName,
        format: "json",
        per_page: 1,
      },
      timeout: 10000,
    });

    if (!response.data?.results?.companies?.[0]) {
      return null;
    }

    const company = response.data.results.companies[0].company;

    return {
      jurisdiction: company.jurisdiction_code,
      companyNumber: company.company_number,
      incorporationDate: company.incorporation_date,
      companyType: company.company_type,
      status: company.current_status,
      confidence: "High",
      sourceUrl: company.opencorporates_url,
    };
  } catch (error) {
    console.error(`Error fetching OpenCorporates data for ${companyName}:`, error);
    return null;
  }
}

/**
 * Aggregate all free API data for a company
 */
export async function aggregateFreeApiData(companyName: string, websiteUrl?: string) {
  const [linkedInData, crunchbaseData, openCorpData] = await Promise.allSettled([
    getLinkedInCompanyData(companyName),
    getCrunchbaseData(companyName, websiteUrl),
    getOpenCorporatesData(companyName),
  ]);

  return {
    linkedIn: linkedInData.status === "fulfilled" ? linkedInData.value : null,
    crunchbase: crunchbaseData.status === "fulfilled" ? crunchbaseData.value : null,
    openCorporates: openCorpData.status === "fulfilled" ? openCorpData.value : null,
  };
}
