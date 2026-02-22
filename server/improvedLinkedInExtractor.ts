/**
 * Improved LinkedIn URL Extractor
 * Focuses on high-quality extraction from website HTML without external APIs
 */

import * as cheerio from "cheerio";

interface LinkedInMatch {
  name: string;
  linkedinUrl: string;
  confidence: "High" | "Medium" | "Low";
  matchMethod: string;
}

export interface ExtractedLinkedInURL {
  url: string;
  context: string;
  nearbyText: string;
  elementType: string;
}

/**
 * Normalize name for matching
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Extract first and last name
 */
function parseFullName(fullName: string): { first: string; last: string; middle: string[] } {
  const parts = fullName.trim().split(/\s+/).filter(p => p.length > 0);
  
  if (parts.length === 0) {
    return { first: "", last: "", middle: [] };
  } else if (parts.length === 1) {
    return { first: parts[0], last: "", middle: [] };
  } else if (parts.length === 2) {
    return { first: parts[0], last: parts[1], middle: [] };
  } else {
    return {
      first: parts[0],
      last: parts[parts.length - 1],
      middle: parts.slice(1, -1),
    };
  }
}

/**
 * Check if a name matches another (handles variations)
 */
function namesMatch(name1: string, name2: string): boolean {
  const norm1 = normalizeName(name1);
  const norm2 = normalizeName(name2);
  
  // Exact match
  if (norm1 === norm2) return true;
  
  // Parse both names
  const parsed1 = parseFullName(norm1);
  const parsed2 = parseFullName(norm2);
  
  // First and last name match
  if (parsed1.first === parsed2.first && parsed1.last === parsed2.last && parsed1.first && parsed1.last) {
    return true;
  }
  
  // Handle "First M. Last" vs "First Middle Last"
  if (parsed1.first === parsed2.first && parsed1.last === parsed2.last) {
    return true;
  }
  
  // Handle nicknames (would need a nickname database, but we can check initials)
  // For now, just check if one name is contained in the other
  if (norm1.includes(norm2) || norm2.includes(norm1)) {
    // Only if it's a substantial match (not just one letter)
    if (Math.min(norm1.length, norm2.length) >= 4) {
      return true;
    }
  }
  
  return false;
}

/**
 * Extract all LinkedIn URLs from HTML with rich context
 */
export function extractAllLinkedInURLs(html: string): ExtractedLinkedInURL[] {
  const $ = cheerio.load(html);
  const linkedinUrls: ExtractedLinkedInURL[] = [];
  const seenUrls = new Set<string>();
  
  // Find all links that contain linkedin.com/in/
  $('a[href*="linkedin.com/in/"], a[href*="linkedin.com/company/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    
    // Only process /in/ profiles (not company pages)
    if (!href.includes("/in/")) return;
    
    // Clean URL (remove query params, trailing slashes, tracking params)
    let cleanUrl = href.split("?")[0].split("#")[0].replace(/\/$/, "");
    
    // Ensure it's a full URL
    if (cleanUrl.startsWith("//")) {
      cleanUrl = "https:" + cleanUrl;
    } else if (cleanUrl.startsWith("/")) {
      cleanUrl = "https://www.linkedin.com" + cleanUrl;
    } else if (!cleanUrl.startsWith("http")) {
      cleanUrl = "https://" + cleanUrl;
    }
    
    // Skip if we've already seen this URL
    if (seenUrls.has(cleanUrl)) return;
    seenUrls.add(cleanUrl);
    
    // Get rich context
    const $el = $(el);
    
    // Get the link text itself
    const linkText = $el.text().trim();
    
    // Get nearby text (parent, siblings)
    const $parent = $el.closest("div, li, section, article, td");
    const nearbyText = $parent.text().replace(/\s+/g, " ").trim();
    
    // Get broader context
    const $container = $el.closest("section, article, div[class*='team'], div[class*='member'], div[class*='person']");
    const context = $container.text().replace(/\s+/g, " ").trim();
    
    // Determine element type for debugging
    const elementType = $parent.prop("tagName") || "unknown";
    
    linkedinUrls.push({
      url: cleanUrl,
      context: context.substring(0, 500), // Limit context length
      nearbyText: nearbyText.substring(0, 200),
      elementType,
    });
  });
  
  console.log(`[LinkedIn Extraction] Found ${linkedinUrls.length} unique LinkedIn URLs on page`);
  
  return linkedinUrls;
}

/**
 * Match team member names to LinkedIn URLs using advanced matching
 */
export function matchLinkedInURLsToTeamMembers(
  linkedinUrls: ExtractedLinkedInURL[],
  teamMemberNames: string[]
): LinkedInMatch[] {
  const matches: LinkedInMatch[] = [];
  const matchedUrls = new Set<string>();
  
  console.log(`[LinkedIn Matching] Attempting to match ${teamMemberNames.length} team members to ${linkedinUrls.length} LinkedIn URLs`);
  
  for (const memberName of teamMemberNames) {
    let bestMatch: LinkedInMatch | null = null;
    
    // Strategy 1: Exact name match in nearby text (highest confidence)
    for (const { url, nearbyText } of linkedinUrls) {
      if (matchedUrls.has(url)) continue;
      
      if (namesMatch(memberName, nearbyText)) {
        bestMatch = {
          name: memberName,
          linkedinUrl: url,
          confidence: "High",
          matchMethod: "Exact name match in nearby text",
        };
        matchedUrls.add(url);
        break;
      }
    }
    
    // Strategy 2: Name appears in broader context
    if (!bestMatch) {
      for (const { url, context } of linkedinUrls) {
        if (matchedUrls.has(url)) continue;
        
        const { first, last } = parseFullName(memberName);
        const contextLower = context.toLowerCase();
        const firstLower = first.toLowerCase();
        const lastLower = last.toLowerCase();
        
        // Check if both first and last name appear in context
        if (firstLower && lastLower && contextLower.includes(firstLower) && contextLower.includes(lastLower)) {
          // Additional check: they should be reasonably close to each other
          const firstIndex = contextLower.indexOf(firstLower);
          const lastIndex = contextLower.indexOf(lastLower);
          
          if (Math.abs(firstIndex - lastIndex) < 100) { // Within 100 characters
            bestMatch = {
              name: memberName,
              linkedinUrl: url,
              confidence: "Medium",
              matchMethod: "Name found in context",
            };
            matchedUrls.add(url);
            break;
          }
        }
      }
    }
    
    // Strategy 3: URL pattern matching (extract name from LinkedIn URL)
    if (!bestMatch) {
      const { first, last } = parseFullName(memberName);
      const firstNorm = first.toLowerCase().replace(/[^a-z]/g, "");
      const lastNorm = last.toLowerCase().replace(/[^a-z]/g, "");
      
      for (const { url } of linkedinUrls) {
        if (matchedUrls.has(url)) continue;
        
        // Extract the profile slug from URL
        const match = url.match(/linkedin\.com\/in\/([^\/]+)/);
        if (!match) continue;
        
        const slug = match[1].toLowerCase();
        
        // Check if slug contains both first and last name
        if (firstNorm && lastNorm && slug.includes(firstNorm) && slug.includes(lastNorm)) {
          bestMatch = {
            name: memberName,
            linkedinUrl: url,
            confidence: "Medium",
            matchMethod: "URL pattern match",
          };
          matchedUrls.add(url);
          break;
        }
        
        // Check for first-last or firstlast patterns
        const expectedPatterns = [
          `${firstNorm}-${lastNorm}`,
          `${firstNorm}${lastNorm}`,
          `${firstNorm[0]}-${lastNorm}`, // First initial
        ];
        
        for (const pattern of expectedPatterns) {
          if (slug === pattern || slug.startsWith(pattern + "-")) {
            bestMatch = {
              name: memberName,
              linkedinUrl: url,
              confidence: "Low",
              matchMethod: "URL pattern match (partial)",
            };
            matchedUrls.add(url);
            break;
          }
        }
        
        if (bestMatch) break;
      }
    }
    
    if (bestMatch) {
      matches.push(bestMatch);
      console.log(`[LinkedIn Matching] ✓ Matched "${memberName}" to ${bestMatch.linkedinUrl} (${bestMatch.confidence} confidence, ${bestMatch.matchMethod})`);
    } else {
      console.log(`[LinkedIn Matching] ✗ No match found for "${memberName}"`);
    }
  }
  
  console.log(`[LinkedIn Matching] Successfully matched ${matches.length}/${teamMemberNames.length} team members`);
  
  return matches;
}

/**
 * Main function: Extract and match LinkedIn URLs from HTML
 */
export function extractAndMatchLinkedInURLs(
  html: string,
  teamMemberNames: string[]
): LinkedInMatch[] {
  // Step 1: Extract all LinkedIn URLs with context
  const linkedinUrls = extractAllLinkedInURLs(html);
  
  // Step 2: Match to team members
  const matches = matchLinkedInURLsToTeamMembers(linkedinUrls, teamMemberNames);
  
  return matches;
}
