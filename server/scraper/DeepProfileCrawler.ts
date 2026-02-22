/**
 * Deep Profile Crawler
 * Clicks into individual team member profile pages to extract:
 * - LinkedIn URLs
 * - Email addresses
 * - Portfolio investments
 */

import * as cheerio from "cheerio";
import { invokeLLM } from "../_core/llm";
import { ComprehensiveScraper } from "./ComprehensiveScraper";

export interface ProfileData {
  linkedinUrl?: string;
  email?: string;
  portfolioInvestments?: PortfolioInvestment[];
}

export interface PortfolioInvestment {
  companyName: string;
  stage?: string;
  description?: string;
  year?: string;
}

export class DeepProfileCrawler {
  private scraper: ComprehensiveScraper;

  constructor() {
    this.scraper = new ComprehensiveScraper();
  }

  /**
   * Detect profile links on a team page
   */
  async detectProfileLinks(html: string, baseUrl: string): Promise<Map<string, string>> {
    const $ = cheerio.load(html);
    const profileLinks = new Map<string, string>(); // name -> URL

    // Common patterns for profile links
    const selectors = [
      'a[href*="/team/"]',
      'a[href*="/people/"]',
      'a[href*="/person/"]',
      'a[href*="/member/"]',
      '.team-member a',
      '.person a',
      '[class*="team"] a[href]',
    ];

    for (const selector of selectors) {
      $(selector).each((_, el) => {
        const href = $(el).attr("href");
        const text = $(el).text().trim();
        
        if (href && text && text.length > 2 && text.length < 50) {
          // Convert relative URLs to absolute
          const fullUrl = href.startsWith("http") 
            ? href 
            : new URL(href, baseUrl).toString();
          
          // Only include if it looks like a profile page (not social media)
          if (!fullUrl.includes("linkedin.com") && 
              !fullUrl.includes("twitter.com") &&
              !fullUrl.includes("facebook.com")) {
            profileLinks.set(text, fullUrl);
          }
        }
      });
    }

    return profileLinks;
  }

  /**
   * Extract profile data from an individual team member's profile page
   */
  async extractProfileData(profileUrl: string, memberName: string): Promise<ProfileData> {
    try {
      console.log(`[Deep Crawler] Fetching profile: ${profileUrl}`);
      
      const result = await this.scraper.scrape({ url: profileUrl });
      const html = result.html;
      
      if (!html || html.length < 100) {
        console.log(`[Deep Crawler] Profile page too short or empty`);
        return {};
      }

      // Extract LinkedIn URL and email using regex patterns
      const linkedinUrl = this.extractLinkedInUrl(html);
      const email = this.extractEmail(html);

      // Extract portfolio investments using LLM
      const portfolioInvestments = await this.extractPortfolioInvestments(html, memberName);

      return {
        linkedinUrl,
        email,
        portfolioInvestments,
      };
    } catch (error) {
      console.error(`[Deep Crawler] Error extracting profile data for ${memberName}:`, error);
      return {};
    }
  }

  /**
   * Extract LinkedIn URL from HTML
   */
  private extractLinkedInUrl(html: string): string | undefined {
    // Pattern 1: Direct LinkedIn link
    const linkedinLinkMatch = html.match(/href=["'](https?:\/\/(?:www\.)?linkedin\.com\/in\/[^"']+)["']/i);
    if (linkedinLinkMatch) {
      return linkedinLinkMatch[1];
    }

    // Pattern 2: LinkedIn URL in text
    const linkedinTextMatch = html.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w-]+/i);
    if (linkedinTextMatch) {
      return linkedinTextMatch[0];
    }

    return undefined;
  }

  /**
   * Extract email address from HTML
   */
  private extractEmail(html: string): string | undefined {
    // Pattern 1: mailto: link
    const mailtoMatch = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
    if (mailtoMatch) {
      return mailtoMatch[1];
    }

    // Pattern 2: Email in text (avoid common false positives like example@example.com)
    const emailMatch = html.match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/);
    if (emailMatch && !emailMatch[1].includes("example.com")) {
      return emailMatch[1];
    }

    return undefined;
  }

  /**
   * Extract portfolio investments using LLM
   */
  private async extractPortfolioInvestments(
    html: string,
    memberName: string
  ): Promise<PortfolioInvestment[] | undefined> {
    try {
      // Clean HTML and extract text
      const $ = cheerio.load(html);
      $("script, style, nav, footer, header").remove();
      const text = $("body").text().replace(/\s+/g, " ").trim();

      // Only process if there's evidence of portfolio/investment information
      if (!text.toLowerCase().includes("portfolio") && 
          !text.toLowerCase().includes("investment") &&
          !text.toLowerCase().includes("company") &&
          !text.toLowerCase().includes("backed")) {
        return undefined;
      }

      // Limit text size for LLM
      const truncatedText = text.substring(0, 10000);

      const prompt = `You are analyzing a venture capital team member's profile page to extract their portfolio investments.

Team Member: ${memberName}

Profile Page Content:
${truncatedText}

Extract all portfolio companies/investments mentioned on this page. For each investment, provide:
1. Company name
2. Stage (if mentioned: Seed, Series A, Series B, Growth, etc.)
3. Brief description (if available)
4. Year of investment (if mentioned)

Return the results as a JSON object with a "portfolio" key containing an array of investments.

Example format:
{
  "portfolio": [
    {"companyName": "Acme Corp", "stage": "Series A", "description": "AI-powered analytics", "year": "2023"},
    {"companyName": "Beta Inc", "stage": "Seed", "description": "", "year": "2024"}
  ]
}

If no portfolio investments are found, return an empty array.`;

      const response = await invokeLLM({
        messages: [
          { role: "system", content: "You are a data extraction assistant. Always return valid JSON." },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "portfolio_extraction",
            strict: true,
            schema: {
              type: "object",
              properties: {
                portfolio: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      companyName: { type: "string" },
                      stage: { type: "string" },
                      description: { type: "string" },
                      year: { type: "string" },
                    },
                    required: ["companyName", "stage", "description", "year"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["portfolio"],
              additionalProperties: false,
            },
          },
        },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) return undefined;

      const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
      const result = JSON.parse(contentStr);
      return result.portfolio && result.portfolio.length > 0 ? result.portfolio : undefined;
    } catch (error) {
      console.error(`[Deep Crawler] Error extracting portfolio for ${memberName}:`, error);
      return undefined;
    }
  }

  /**
   * Enrich team members with profile data
   */
  async enrichTeamMembersWithProfiles<T extends { name: string }>(
    teamMembers: T[],
    teamPageUrl: string,
    teamPageHtml: string,
    onProgress?: (message: string) => void
  ): Promise<(T & ProfileData)[]> {
    const baseUrl = new URL(teamPageUrl).origin;
    
    // Detect profile links
    onProgress?.("Detecting profile links...");
    const profileLinks = await this.detectProfileLinks(teamPageHtml, baseUrl);
    
    console.log(`[Deep Crawler] Found ${profileLinks.size} potential profile links`);

    const enrichedMembers: (T & ProfileData)[] = [];

    for (let i = 0; i < teamMembers.length; i++) {
      const member = teamMembers[i];
      const profileUrl = profileLinks.get(member.name);

      if (profileUrl) {
        onProgress?.(`Extracting profile data for ${member.name} (${i + 1}/${teamMembers.length})...`);
        
        const profileData = await this.extractProfileData(profileUrl, member.name);
        enrichedMembers.push({ ...member, ...profileData });
        
        // Rate limiting: wait 1 second between profile requests
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        // No profile link found, add member without profile data
        enrichedMembers.push({ ...member });
      }
    }

    return enrichedMembers;
  }

  /**
   * Cleanup
   */
  async cleanup() {
    // Scraper cleanup is handled automatically
  }
}
