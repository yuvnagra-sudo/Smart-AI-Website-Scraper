/**
 * LinkedIn Company Page Scraper
 * Extracts employee profiles from LinkedIn company pages
 */

import axios from "axios";
import * as cheerio from "cheerio";

interface CompanyEmployee {
  name: string;
  title: string;
  linkedinUrl: string;
  confidence: "High" | "Medium" | "Low";
}

/**
 * Extract LinkedIn company URL from VC firm website
 */
export async function findCompanyLinkedInURL(websiteHtml: string, companyName: string): Promise<string | null> {
  const $ = cheerio.load(websiteHtml);
  
  // Strategy 1: Look for LinkedIn company links
  const companyLinks: string[] = [];
  
  $('a[href*="linkedin.com/company/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      companyLinks.push(href);
    }
  });
  
  if (companyLinks.length > 0) {
    // Clean and return the first company URL found
    let url = companyLinks[0].split("?")[0].split("#")[0];
    if (url.startsWith("//")) {
      url = "https:" + url;
    } else if (!url.startsWith("http")) {
      url = "https://" + url;
    }
    console.log(`[LinkedIn Company] Found company page: ${url}`);
    return url;
  }
  
  // Strategy 2: Check structured data
  let urlFromStructuredData: string | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (urlFromStructuredData) return false; // Stop if found
    try {
      const data = JSON.parse($(el).text());
      if (data.sameAs && Array.isArray(data.sameAs)) {
        for (const url of data.sameAs) {
          if (typeof url === 'string' && url.includes('linkedin.com/company/')) {
            console.log(`[LinkedIn Company] Found in structured data: ${url}`);
            urlFromStructuredData = url;
            return false; // Stop iteration
          }
        }
      }
    } catch (e) {
      // Invalid JSON, skip
    }
  });
  
  if (urlFromStructuredData) {
    return urlFromStructuredData;
  }
  
  // Strategy 3: Construct likely URL from company name
  const slug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
  
  const likelyUrl = `https://www.linkedin.com/company/${slug}`;
  console.log(`[LinkedIn Company] Constructed URL: ${likelyUrl}`);
  
  return likelyUrl;
}

/**
 * Scrape employee profiles from LinkedIn company page
 * Note: This is a simplified version. LinkedIn's actual people page requires authentication.
 * For production, consider using LinkedIn API or a service like Proxycurl.
 */
export async function scrapeCompanyEmployees(
  companyLinkedInUrl: string,
  teamMemberNames: string[]
): Promise<CompanyEmployee[]> {
  console.log(`[LinkedIn Company] Attempting to scrape: ${companyLinkedInUrl}/people`);
  
  // Note: LinkedIn blocks automated scraping. This is a placeholder for the architecture.
  // In production, you would:
  // 1. Use LinkedIn Official API (requires partnership)
  // 2. Use Proxycurl API (paid service, $0.01/profile)
  // 3. Use RapidAPI LinkedIn scrapers
  // 4. Use browser automation with authentication
  
  const employees: CompanyEmployee[] = [];
  
  try {
    // Attempt to fetch the people page
    const response = await axios.get(`${companyLinkedInUrl}/people`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 10000,
    });
    
    const $ = cheerio.load(response.data);
    
    // LinkedIn's HTML structure (this is simplified and may not work due to anti-scraping)
    $('.org-people-profile-card').each((_, el) => {
      const $card = $(el);
      const name = $card.find('.org-people-profile-card__profile-title').text().trim();
      const title = $card.find('.org-people-profile-card__profile-subtitle').text().trim();
      const profileLink = $card.find('a.app-aware-link').attr('href');
      
      if (name && profileLink) {
        // Check if this person is in our team member list
        const isMatch = teamMemberNames.some(memberName => 
          name.toLowerCase().includes(memberName.toLowerCase()) ||
          memberName.toLowerCase().includes(name.toLowerCase())
        );
        
        if (isMatch) {
          employees.push({
            name,
            title,
            linkedinUrl: profileLink.startsWith('http') ? profileLink : `https://www.linkedin.com${profileLink}`,
            confidence: "High",
          });
        }
      }
    });
    
    console.log(`[LinkedIn Company] Found ${employees.length} matching employees`);
    
  } catch (error: any) {
    if (error.response?.status === 429) {
      console.warn(`[LinkedIn Company] Rate limited by LinkedIn`);
    } else if (error.response?.status === 403) {
      console.warn(`[LinkedIn Company] Access forbidden - LinkedIn blocks automated scraping`);
    } else {
      console.warn(`[LinkedIn Company] Error scraping: ${error.message}`);
    }
  }
  
  return employees;
}

/**
 * Alternative: Use Proxycurl API to get company employees
 * This is a paid service but very reliable
 */
export async function getCompanyEmployeesViaProxycurl(
  companyLinkedInUrl: string,
  apiKey: string
): Promise<CompanyEmployee[]> {
  // Proxycurl API endpoint
  const apiUrl = "https://nubela.co/proxycurl/api/v2/linkedin/company/employees/";
  
  try {
    const response = await axios.get(apiUrl, {
      params: {
        url: companyLinkedInUrl,
        page_size: 100, // Get up to 100 employees
      },
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      },
      timeout: 30000,
    });
    
    const employees: CompanyEmployee[] = response.data.employees.map((emp: any) => ({
      name: `${emp.first_name} ${emp.last_name}`,
      title: emp.title || "",
      linkedinUrl: emp.profile_url,
      confidence: "High" as const,
    }));
    
    console.log(`[Proxycurl] Retrieved ${employees.length} employees`);
    return employees;
    
  } catch (error: any) {
    console.error(`[Proxycurl] Error: ${error.message}`);
    return [];
  }
}

/**
 * Main function: Try to get employees from LinkedIn company page
 */
export async function enrichFromLinkedInCompanyPage(
  websiteHtml: string,
  companyName: string,
  teamMemberNames: string[],
  proxycurlApiKey?: string
): Promise<CompanyEmployee[]> {
  // Step 1: Find the company LinkedIn URL
  const companyUrl = await findCompanyLinkedInURL(websiteHtml, companyName);
  
  if (!companyUrl) {
    console.log(`[LinkedIn Company] Could not find company LinkedIn URL`);
    return [];
  }
  
  // Step 2: Try Proxycurl if API key is provided
  if (proxycurlApiKey) {
    const employees = await getCompanyEmployeesViaProxycurl(companyUrl, proxycurlApiKey);
    if (employees.length > 0) {
      return employees;
    }
  }
  
  // Step 3: Fall back to direct scraping (likely to fail due to LinkedIn anti-scraping)
  const employees = await scrapeCompanyEmployees(companyUrl, teamMemberNames);
  
  return employees;
}
