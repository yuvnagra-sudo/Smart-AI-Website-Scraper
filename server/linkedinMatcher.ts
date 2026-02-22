/**
 * LinkedIn URL Matching and Validation
 * 
 * Matches team member names to LinkedIn URLs and validates them
 */

import axios from "axios";
import * as cheerio from "cheerio";

interface LinkedInMatch {
  name: string;
  linkedinUrl: string;
  confidence: "High" | "Medium" | "Low";
  matchMethod: string;
}

/**
 * Normalize a name for matching
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "-");
}

/**
 * Extract first and last name from full name
 */
function parseFullName(fullName: string): { first: string; last: string; middle?: string } {
  const parts = fullName.trim().split(/\s+/);
  
  if (parts.length === 1) {
    return { first: parts[0], last: "" };
  } else if (parts.length === 2) {
    return { first: parts[0], last: parts[1] };
  } else {
    return { first: parts[0], middle: parts.slice(1, -1).join(" "), last: parts[parts.length - 1] };
  }
}

/**
 * Generate possible LinkedIn URL variations for a name
 */
export function generateLinkedInVariations(fullName: string): string[] {
  const { first, last, middle } = parseFullName(fullName);
  const variations: string[] = [];
  
  const firstNorm = first.toLowerCase().replace(/[^a-z]/g, "");
  const lastNorm = last.toLowerCase().replace(/[^a-z]/g, "");
  const middleNorm = middle?.toLowerCase().replace(/[^a-z]/g, "") || "";
  
  // Common patterns:
  // 1. firstname-lastname
  variations.push(`${firstNorm}-${lastNorm}`);
  
  // 2. firstnamelastname (no dash)
  variations.push(`${firstNorm}${lastNorm}`);
  
  // 3. firstname-middlename-lastname
  if (middleNorm) {
    variations.push(`${firstNorm}-${middleNorm}-${lastNorm}`);
  }
  
  // 4. f-lastname (first initial)
  variations.push(`${firstNorm[0]}-${lastNorm}`);
  
  // 5. firstname-l (last initial)
  variations.push(`${firstNorm}-${lastNorm[0]}`);
  
  // 6. firstname-lastname-numbers (common pattern)
  for (let i = 1; i <= 5; i++) {
    variations.push(`${firstNorm}-${lastNorm}-${i}`);
  }
  
  // Convert to full URLs
  return variations.map(v => `https://www.linkedin.com/in/${v}`);
}

/**
 * Validate if a LinkedIn URL exists (without logging in)
 */
export async function validateLinkedInURL(url: string): Promise<boolean> {
  try {
    const response = await axios.head(url, {
      timeout: 5000,
      maxRedirects: 0,
      validateStatus: (status) => status === 200 || status === 999, // 999 is LinkedIn's rate limit response
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    
    // 200 = profile exists
    // 999 = LinkedIn rate limiting (profile likely exists)
    return response.status === 200 || response.status === 999;
  } catch (error: any) {
    // 404 = profile doesn't exist
    if (error.response?.status === 404) {
      return false;
    }
    // For other errors (network, timeout), assume it might exist
    return false;
  }
}

/**
 * Extract LinkedIn URLs from HTML and match to team member names
 */
export async function matchLinkedInURLsToNames(
  html: string,
  teamMemberNames: string[]
): Promise<LinkedInMatch[]> {
  const $ = cheerio.load(html);
  const matches: LinkedInMatch[] = [];
  
  // Extract all LinkedIn URLs from the page
  const linkedinUrls: { url: string; context: string }[] = [];
  
  $('a[href*="linkedin.com/in/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      // Clean URL (remove query params, trailing slashes)
      const cleanUrl = href.split("?")[0].replace(/\/$/, "");
      
      // Get surrounding text for context matching
      const context = $(el).closest("div, section, article").text().toLowerCase();
      
      linkedinUrls.push({ url: cleanUrl, context });
    }
  });
  
  // Try to match each team member to a LinkedIn URL
  for (const memberName of teamMemberNames) {
    const nameLower = memberName.toLowerCase();
    const { first, last } = parseFullName(memberName);
    
    // Method 1: Direct context matching (name appears near LinkedIn URL)
    for (const { url, context } of linkedinUrls) {
      if (context.includes(nameLower) || 
          (context.includes(first.toLowerCase()) && context.includes(last.toLowerCase()))) {
        matches.push({
          name: memberName,
          linkedinUrl: url,
          confidence: "High",
          matchMethod: "Context match (name near URL)",
        });
        break;
      }
    }
    
    // If no context match, try Method 2: URL pattern matching
    if (!matches.find(m => m.name === memberName)) {
      const variations = generateLinkedInVariations(memberName);
      
      for (const variation of variations) {
        // Check if this variation exists in the extracted URLs
        const found = linkedinUrls.find(({ url }) => url === variation);
        if (found) {
          matches.push({
            name: memberName,
            linkedinUrl: found.url,
            confidence: "Medium",
            matchMethod: "URL pattern match",
          });
          break;
        }
      }
    }
    
    // If still no match, try Method 3: Validate generated URLs
    if (!matches.find(m => m.name === memberName)) {
      const variations = generateLinkedInVariations(memberName).slice(0, 3); // Only try top 3
      
      for (const url of variations) {
        const exists = await validateLinkedInURL(url);
        if (exists) {
          matches.push({
            name: memberName,
            linkedinUrl: url,
            confidence: "Low",
            matchMethod: "Generated and validated",
          });
          break;
        }
        
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }
  
  return matches;
}

/**
 * Enhanced LinkedIn URL matching with Google search waterfall
 */
export async function matchLinkedInURLsWithWaterfall(
  html: string,
  teamMemberNames: string[],
  companyName: string,
  onProgress?: (message: string) => void
): Promise<LinkedInMatch[]> {
  // First, try the standard matching
  const initialMatches = await matchLinkedInURLsToNames(html, teamMemberNames);
  
  // For team members without matches or with low confidence, try Google search
  const finalMatches: LinkedInMatch[] = [...initialMatches];
  
  for (const memberName of teamMemberNames) {
    const existingMatch = finalMatches.find(m => m.name === memberName);
    
    // Only use Google search if no match found or confidence is Low
    if (!existingMatch || existingMatch.confidence === "Low") {
      onProgress?.(`Searching Google for ${memberName}'s LinkedIn profile...`);
      
      const googleUrl = await searchLinkedInViaGoogle(memberName, companyName);
      
      if (googleUrl) {
        // Remove existing low-confidence match if present
        const index = finalMatches.findIndex(m => m.name === memberName);
        if (index !== -1) {
          finalMatches.splice(index, 1);
        }
        
        finalMatches.push({
          name: memberName,
          linkedinUrl: googleUrl,
          confidence: "Medium",
          matchMethod: "Google search + validation",
        });
        
        onProgress?.(`✓ Found ${memberName}'s LinkedIn via Google`);
      }
      
      // Add delay to avoid Google rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  return finalMatches;
}

/**
 * Backward compatibility wrapper
 */
export async function matchLinkedInURLsToNamesLegacy(
  html: string,
  teamMemberNames: string[]
): Promise<LinkedInMatch[]> {
  return matchLinkedInURLsToNames(html, teamMemberNames);
}

// Keep original function for internal use
async function matchLinkedInURLsToNamesInternal(
  html: string,
  teamMemberNames: string[]
): Promise<LinkedInMatch[]> {
  const $ = cheerio.load(html);
  const matches: LinkedInMatch[] = [];
  
  // Extract all LinkedIn URLs from the page
  const linkedinUrls: { url: string; context: string }[] = [];
  
  $('a[href*="linkedin.com/in/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      // Clean URL (remove query params, trailing slashes)
      const cleanUrl = href.split("?")[0].replace(/\/$/, "");
      
      // Get surrounding text for context matching
      const context = $(el).closest("div, section, article").text().toLowerCase();
      
      linkedinUrls.push({ url: cleanUrl, context });
    }
  });
  
  // Try to match each team member to a LinkedIn URL
  for (const memberName of teamMemberNames) {
    const nameLower = memberName.toLowerCase();
    const { first, last } = parseFullName(memberName);
    
    // Method 1: Direct context matching (name appears near LinkedIn URL)
    for (const { url, context } of linkedinUrls) {
      if (context.includes(nameLower) || 
          (context.includes(first.toLowerCase()) && context.includes(last.toLowerCase()))) {
        matches.push({
          name: memberName,
          linkedinUrl: url,
          confidence: "High",
          matchMethod: "Context match (name near URL)",
        });
        break;
      }
    }
    
    // If no context match, try Method 2: URL pattern matching
    if (!matches.find(m => m.name === memberName)) {
      const variations = generateLinkedInVariations(memberName);
      
      for (const variation of variations) {
        // Check if this variation exists in the extracted URLs
        const found = linkedinUrls.find(({ url }) => url === variation);
        if (found) {
          matches.push({
            name: memberName,
            linkedinUrl: found.url,
            confidence: "Medium",
            matchMethod: "URL pattern match",
          });
          break;
        }
      }
    }
    
    // If still no match, try Method 3: Validate generated URLs
    if (!matches.find(m => m.name === memberName)) {
      const variations = generateLinkedInVariations(memberName).slice(0, 3); // Only try top 3
      
      for (const url of variations) {
        const exists = await validateLinkedInURL(url);
        if (exists) {
          matches.push({
            name: memberName,
            linkedinUrl: url,
            confidence: "Low",
            matchMethod: "Generated and validated",
          });
          break;
        }
        
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }
  
  return matches;
}

/**
 * Search Google for LinkedIn profile URL
 */
export async function searchLinkedInViaGoogle(
  personName: string,
  companyName: string
): Promise<string | null> {
  try {
    // Use Google search to find LinkedIn profile
    const searchQuery = `${personName} ${companyName} site:linkedin.com/in/`;
    const encodedQuery = encodeURIComponent(searchQuery);
    
    // Note: This is a simplified version. In production, you'd want to use:
    // - Google Custom Search API (100 free queries/day)
    // - SerpAPI (paid service with better reliability)
    // - Bing Search API (alternative)
    
    const searchUrl = `https://www.google.com/search?q=${encodedQuery}`;
    
    const response = await axios.get(searchUrl, {
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    
    const $ = cheerio.load(response.data);
    
    // Extract LinkedIn URLs from search results
    const linkedinUrls: string[] = [];
    
    $("a[href*='linkedin.com/in/']").each((_, el) => {
      const href = $(el).attr("href");
      if (href) {
        // Google wraps URLs, extract the actual LinkedIn URL
        const match = href.match(/linkedin\.com\/in\/([^&\/\?]+)/);
        if (match) {
          const cleanUrl = `https://www.linkedin.com/in/${match[1]}`;
          if (!linkedinUrls.includes(cleanUrl)) {
            linkedinUrls.push(cleanUrl);
          }
        }
      }
    });
    
    // Return the first result (most relevant)
    if (linkedinUrls.length > 0) {
      // Validate that it's actually accessible
      const isValid = await validateLinkedInURL(linkedinUrls[0]);
      return isValid ? linkedinUrls[0] : null;
    }
    
    return null;
  } catch (error) {
    console.error(`Error searching Google for LinkedIn profile:`, error);
    return null;
  }
}

/**
 * Scrape LinkedIn profile for specialization data (public view only)
 */
export async function scrapeLinkedInProfile(url: string): Promise<{
  headline: string;
  about: string;
  specialization: string[];
} | null> {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    
    const $ = cheerio.load(response.data);
    
    // LinkedIn's public profile structure (may change)
    const headline = $('h2.top-card-layout__headline').text().trim() ||
                    $('[class*="headline"]').first().text().trim();
    
    const about = $('[class*="summary"]').text().trim() ||
                 $('[class*="about"]').text().trim();
    
    // Extract specialization keywords from headline and about
    const specialization: string[] = [];
    const combinedText = `${headline} ${about}`.toLowerCase();
    
    // Common VC specialization keywords
    const specializationKeywords = [
      "fintech", "healthtech", "biotech", "saas", "enterprise",
      "consumer", "b2b", "b2c", "ai", "ml", "crypto", "web3",
      "climate", "cleantech", "edtech", "proptech", "marketplace",
      "infrastructure", "devtools", "security", "cybersecurity",
    ];
    
    specializationKeywords.forEach(keyword => {
      if (combinedText.includes(keyword)) {
        specialization.push(keyword);
      }
    });
    
    return {
      headline,
      about,
      specialization,
    };
  } catch (error) {
    console.error(`Error scraping LinkedIn profile ${url}:`, error);
    return null;
  }
}
