/**
 * Team Member Detail Page Extractor
 * Extracts additional information from individual team member profile pages
 */

import * as cheerio from "cheerio";
import { queuedLLMCall } from "./_core/llmQueue";
import { convertUrlToMarkdown } from "./jinaReader";

export interface TeamMemberDetailData {
  title: string; // Actual job title from profile page
  bio: string;
  investmentPhilosophy: string;
  personalInterests: string[];
  linkedinUrl: string;
  twitterUrl: string;
  email: string;
  portfolioCompanies: string[]; // Company names from their personal portfolio
}

/**
 * Detect if a team member has a clickable profile link
 * Now uses Jina Reader for better semantic understanding
 */
export async function extractTeamMemberProfileLinks(html: string, baseUrl: string): Promise<Map<string, string>> {
  const profileLinks = new Map<string, string>();
  
  // Try Jina Reader first for semantic link detection
  const jinaResult = await convertUrlToMarkdown(baseUrl);
  
  if (jinaResult) {
    console.log(`[TeamMemberDetailExtractor] Using Jina to detect profile links`);
    
    // Use LLM to identify profile links from markdown
    const prompt = `You are analyzing a VC firm's team page to find individual team member profile URLs.

Page URL: ${baseUrl}
Page content (markdown):
${jinaResult.markdown}

Links found:
${JSON.stringify(jinaResult.links, null, 2)}

Identify URLs that lead to individual team member profile pages. These typically:
- Contain a person's name in the URL or link text
- Lead to dedicated profile/bio pages (e.g., /people/john-smith, /team/jane-doe, /person/bob-jones)
- Are NOT category pages (e.g., NOT /team/partners, /team/seed-stage)
- Are NOT external links (LinkedIn, Twitter, etc.)

For each profile link, provide:
1. name: The person's full name (from link text or URL)
2. url: The full profile URL

Return as JSON array. If no profile links found, return empty array.`;

    try {
      const response = await queuedLLMCall({
        messages: [{ role: "user", content: prompt }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "profile_links",
            strict: true,
            schema: {
              type: "object",
              properties: {
                profiles: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      url: { type: "string" },
                    },
                    required: ["name", "url"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["profiles"],
              additionalProperties: false,
            },
          },
        },
      }, 3);

      const content = response.choices[0]?.message?.content;
      const result = JSON.parse(typeof content === 'string' ? content : '{}');
      const profiles = result.profiles || [];

      console.log(`[TeamMemberDetailExtractor] Jina LLM found ${profiles.length} profile links`);

      for (const profile of profiles) {
        profileLinks.set(profile.name, profile.url);
      }

      if (profileLinks.size > 0) {
        console.log(`[TeamMemberDetailExtractor] Found ${profileLinks.size} profile links via Jina`);
        return profileLinks;
      }
    } catch (error) {
      console.error(`[TeamMemberDetailExtractor] Jina LLM error:`, error);
    }
  }
  
  // Fallback to HTML parsing if Jina fails or finds nothing
  console.log(`[TeamMemberDetailExtractor] Falling back to HTML parsing`);
  const $ = cheerio.load(html);
  
  // Look for team member links in common patterns
  const selectors = [
    'a[href*="/people/"]',
    'a[href*="/team/"]',
    'a[href*="/person/"]',
    'a[href*="/member/"]',
    'a[href*="/bio/"]',
    'a[href*="/profile/"]',
    'a[id*="member"]',  // Bessemer uses id="all-member-1"
    'a[id*="person"]',
    'a[id*="team"]',
    '.team-member a',
    '.person a',
    '.profile a',
    '.team-grid a',
    '.people-grid a',
  ];
  
  for (const selector of selectors) {
    $(selector).each((_, elem) => {
      const $link = $(elem);
      let href = $link.attr('href');
      const name = $link.text().trim();
      
      // For JavaScript-based links (like Bessemer), construct URL from id
      if (!href && $link.attr('id')) {
        const id = $link.attr('id');
        // Try to find onclick or data attributes
        const onclick = $link.attr('onclick');
        if (onclick) {
          // Extract URL from onclick if present
          const match = onclick.match(/['"]([^'"]+)['"]/);
          if (match) href = match[1];
        }
        // If still no href, skip (can't construct URL reliably)
      }
      
      if (href && name && name.length > 2 && name.length < 100) {
        // Build full URL
        let fullUrl = href;
        if (href.startsWith('/')) {
          const base = new URL(baseUrl);
          fullUrl = `${base.protocol}//${base.host}${href}`;
        } else if (!href.startsWith('http')) {
          fullUrl = `${baseUrl}/${href}`;
        }
        
        // Clean name (remove extra whitespace, newlines)
        const cleanName = name.replace(/\s+/g, ' ').trim();
        
        // Only add if it looks like a person's name (has at least 2 words)
        if (cleanName.split(' ').length >= 2) {
          profileLinks.set(cleanName, fullUrl);
        }
      }
    });
  }
  
  console.log(`[TeamMemberDetailExtractor] Found ${profileLinks.size} profile links`);
  return profileLinks;
}

/**
 * Extract detailed information from a team member's profile page
 */
export async function extractTeamMemberDetails(
  html: string,
  memberName: string,
  profileUrl: string
): Promise<TeamMemberDetailData | null> {
  console.log(`[TeamMemberDetailExtractor] Extracting details for ${memberName} from ${profileUrl}`);
  
  const $ = cheerio.load(html);
  
  // Remove noise
  $("script, style, nav, footer, header, .cookie, .banner").remove();
  
  // Extract social media links
  let linkedinUrl = "";
  let twitterUrl = "";
  let extractedEmail = "";
  
  $('a[href*="linkedin.com"]').each((_, elem) => {
    const href = $(elem).attr('href');
    if (href && !linkedinUrl) {
      linkedinUrl = href;
    }
  });
  
  $('a[href*="twitter.com"], a[href*="x.com"]').each((_, elem) => {
    const href = $(elem).attr('href');
    if (href && !twitterUrl) {
      twitterUrl = href;
    }
  });
  
  // Extract email from mailto: links first (most reliable)
  $('a[href^="mailto:"]').each((_, elem) => {
    const href = $(elem).attr('href');
    if (href && !extractedEmail) {
      const email = href.replace('mailto:', '').split('?')[0].trim();
      // Validate email format
      if (email.match(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/)) {
        extractedEmail = email;
        console.log(`[TeamMemberDetailExtractor] Found mailto email for ${memberName}: ${email}`);
      }
    }
  });
  
  // If no mailto found, search for email patterns in text
  if (!extractedEmail) {
    const pageText = $('body').text();
    // Look for email patterns near the person's name or common email indicators
    const emailPatterns = [
      // Pattern: firstname.lastname@domain.com or firstname@domain.com
      /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g,
    ];
    
    for (const pattern of emailPatterns) {
      const matches = pageText.match(pattern);
      if (matches) {
        for (const match of matches) {
          // Filter out common false positives
          const lowerMatch = match.toLowerCase();
          if (!lowerMatch.includes('example.com') && 
              !lowerMatch.includes('placeholder') &&
              !lowerMatch.includes('email@') &&
              !lowerMatch.includes('your@') &&
              !lowerMatch.includes('info@') &&
              !lowerMatch.includes('contact@') &&
              !lowerMatch.includes('hello@') &&
              !lowerMatch.includes('support@') &&
              !lowerMatch.includes('careers@') &&
              !lowerMatch.includes('press@') &&
              !lowerMatch.includes('media@')) {
            extractedEmail = match;
            console.log(`[TeamMemberDetailExtractor] Found text email for ${memberName}: ${match}`);
            break;
          }
        }
      }
      if (extractedEmail) break;
    }
  }
  
  // Extract portfolio companies from tables
  const portfolioCompanies: string[] = [];
  
  // Look for portfolio tables
  $('table').each((_, table) => {
    const $table = $(table);
    const tableText = $table.text().toLowerCase();
    
    // Check if this is a portfolio table
    if (tableText.includes('compan') || tableText.includes('portfolio') || tableText.includes('investment')) {
      $table.find('tr').each((_, row) => {
        const $row = $(row);
        const cells = $row.find('td');
        
        if (cells.length > 0) {
          // First cell usually contains company name
          const companyName = $(cells[0]).text().trim();
          if (companyName && companyName.length > 1 && companyName.length < 100) {
            portfolioCompanies.push(companyName);
          }
        }
      });
    }
  });
  
  // Get full page text for LLM analysis
  const fullText = $("body").text().replace(/\s+/g, " ").trim();
  
  // Use LLM to extract title, bio, philosophy, and interests
  const prompt = `You are analyzing a venture capital team member's profile page.

Team Member: ${memberName}
Profile URL: ${profileUrl}

Page Content (first 12000 chars):
${fullText}

Extract the following information:
1. Job Title - Their exact job title (e.g., "General Partner", "Managing Director", "Principal", "Partner", "Associate", "Venture Partner")
2. Bio/Backstory - A comprehensive summary of their career journey and background (2-3 sentences)
3. Investment Philosophy - Their investment criteria, what they look for in companies, their approach (1-2 sentences)
4. Personal Interests - List of hobbies, interests, or personal details mentioned (comma-separated)
5. Email - Their email address if mentioned on the page (look for patterns like name@firm.com)

If any field is not found, return an empty string or empty array.

Return as JSON:
{
  "title": "string",
  "bio": "string",
  "investment_philosophy": "string",
  "personal_interests": ["interest1", "interest2", ...],
  "email": "string"
}`;

  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "team_member_details",
          strict: true,
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
              bio: { type: "string" },
              investment_philosophy: { type: "string" },
              personal_interests: {
                type: "array",
                items: { type: "string" },
              },
              email: { type: "string" },
            },
            required: ["title", "bio", "investment_philosophy", "personal_interests", "email"],
            additionalProperties: false,
          },
        },
      },
    }, 3); // Priority 3 (lower than core extraction)

    const content = response.choices[0]?.message?.content;
    const result = JSON.parse(typeof content === 'string' ? content : '{}');

    // Prefer HTML-extracted email over LLM-extracted (more reliable)
    const finalEmail = extractedEmail || result.email || "";
    
    const details: TeamMemberDetailData = {
      title: result.title || "",
      bio: result.bio || "",
      investmentPhilosophy: result.investment_philosophy || "",
      personalInterests: result.personal_interests || [],
      linkedinUrl,
      twitterUrl,
      email: finalEmail,
      portfolioCompanies: portfolioCompanies, // No limit - extract all portfolio companies
    };

    console.log(`[TeamMemberDetailExtractor] ✓ Extracted details for ${memberName}: bio=${details.bio.length} chars, email=${finalEmail ? 'found' : 'none'}, ${details.portfolioCompanies.length} portfolio companies`);
    
    return details;
  } catch (error) {
    console.error(`[TeamMemberDetailExtractor] Error extracting details for ${memberName}:`, error);
    return null;
  }
}
