/**
 * Team URL Detector
 * Detects region-specific or stage-specific team URLs from a team page
 */

import * as cheerio from "cheerio";
import { queuedLLMCall } from "./_core/llmQueue";
import { convertUrlToMarkdown } from "./jinaReader";

export interface TeamUrlVariant {
  url: string;
  category: string; // "region", "stage", "office", or "other"
  label: string; // "Bay Area", "Early Stage", "London", etc.
}

/**
 * Detect region/stage-specific team URLs from HTML
 * Examples:
 * - Accel: /team#global, /team#bay-area, /team#london, /team#bangalore
 * - Others: /team/early-stage, /team/growth, /team/us, /team/europe
 */
export async function detectTeamUrlVariants(
  html: string,
  baseUrl: string,
  companyName: string
): Promise<TeamUrlVariant[]> {
  console.log(`[TeamUrlDetector] Analyzing team page for ${companyName}`);
  
  // Try Jina Reader first for clean, structured markdown
  const jinaResult = await convertUrlToMarkdown(baseUrl);
  
  let pageContent: string;
  let links: Array<{ href: string; text: string }> = [];
  
  if (jinaResult) {
    console.log(`[TeamUrlDetector] Using Jina markdown (${jinaResult.markdown.length} chars, ${jinaResult.links.length} links)`);
    pageContent = jinaResult.markdown;
    links = jinaResult.links.map(l => ({ href: l.url, text: l.text }));
  } else {
    console.log(`[TeamUrlDetector] Jina failed, falling back to HTML parsing`);
    const $ = cheerio.load(html);
    
    // Extract all links from the page
    $('a').each((_, elem) => {
      const href = $(elem).attr('href');
      const text = $(elem).text().trim();
      
      if (href && text) {
        links.push({ href, text });
      }
    });
    
    // Also check for tabs, buttons, and navigation elements
    $('[role="tab"], button, nav a, .tab, .filter, .location, .region, .office').each((_, elem) => {
      const href = $(elem).attr('href') || $(elem).attr('data-url') || '';
      const text = $(elem).text().trim();
      
      if (text) {
        links.push({ href, text });
      }
    });
    
    pageContent = `Links found: ${JSON.stringify(links, null, 2)}`;
  }
  
  console.log(`[TeamUrlDetector] Found ${links.length} total links/tabs`);
  
  // Use LLM to identify team-related regional/stage URLs
  const prompt = `You are analyzing a venture capital firm's team page to find region-specific, stage-specific, or role-specific team URLs.

Company: ${companyName}
Base URL: ${baseUrl}

${jinaResult ? 'Page content (markdown):' : 'Links found:'}
${pageContent}

Identify URLs that represent different regions, offices, stages, roles, or categories of team members. Examples:
- Regional: "Bay Area", "London", "Bangalore", "New York", "Europe", "Asia"
- Stage-based: "Early Stage", "Late Stage", "Growth", "Seed"
- Role-based: "Partners", "Investors", "Principals", "Associates", "Advisors"
- Office-based: "SF Office", "NYC Office", "Global"
- Query parameters: "?_role=seed-early", "?_role=growth", "?team=partners"

For each relevant URL, provide:
1. The href (URL or hash fragment)
2. Category: "region", "stage", "office", or "other"
3. Label: The human-readable name (e.g., "Bay Area", "Early Stage Team")

Ignore:
- Individual profile pages
- Non-team pages (about, contact, portfolio, news)
- Social media links
- External links

Return as JSON array. If no relevant URLs found, return empty array.`;

  try {
    const response = await queuedLLMCall({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "team_url_variants",
          strict: true,
          schema: {
            type: "object",
            properties: {
              variants: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    href: { type: "string" },
                    category: { type: "string" },
                    label: { type: "string" },
                  },
                  required: ["href", "category", "label"],
                  additionalProperties: false,
                },
              },
            },
            required: ["variants"],
            additionalProperties: false,
          },
        },
      },
    }, 3); // Priority 3

    const content = response.choices[0]?.message?.content;
    const result = JSON.parse(typeof content === 'string' ? content : '{}');
    const variants = result.variants || [];
    
    console.log(`[TeamUrlDetector] LLM identified ${variants.length} variant URLs`);
    
    // Convert to absolute URLs
    const teamUrls: TeamUrlVariant[] = variants.map((v: any) => {
      let url = v.href;
      
      // Handle hash fragments (e.g., #bay-area)
      if (url.startsWith('#')) {
        url = `${baseUrl}${url}`;
      }
      // Handle relative URLs
      else if (url.startsWith('/')) {
        const base = new URL(baseUrl);
        url = `${base.protocol}//${base.host}${url}`;
      }
      // Handle full URLs
      else if (!url.startsWith('http')) {
        url = `${baseUrl}/${url}`;
      }
      
      return {
        url: url.replace(/\/+/g, '/').replace(':/', '://'),
        category: v.category,
        label: v.label,
      };
    });
    
    // Deduplicate by URL
    const uniqueUrls = Array.from(
      new Map(teamUrls.map(u => [u.url, u])).values()
    );
    
    console.log(`[TeamUrlDetector] Returning ${uniqueUrls.length} unique team URLs`);
    uniqueUrls.forEach(u => {
      console.log(`  - ${u.label} (${u.category}): ${u.url}`);
    });
    
    return uniqueUrls;
    
  } catch (error) {
    console.error("[TeamUrlDetector] Error:", error);
    return [];
  }
}
