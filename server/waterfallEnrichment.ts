/**
 * Waterfall Enrichment
 * Tries multiple sources to improve data quality for low-confidence results
 */

import axios from "axios";
import * as cheerio from "cheerio";

export interface WaterfallSource {
  url: string;
  priority: number;
  description: string;
}

/**
 * Generate potential URLs to try for a given base URL
 */
export function generateWaterfallUrls(baseUrl: string): WaterfallSource[] {
  // Remove trailing slash
  const cleanUrl = baseUrl.replace(/\/$/, "");
  
  return [
    { url: cleanUrl, priority: 1, description: "Homepage" },
    { url: `${cleanUrl}/about`, priority: 2, description: "About page" },
    { url: `${cleanUrl}/about-us`, priority: 2, description: "About Us page" },
    { url: `${cleanUrl}/team`, priority: 3, description: "Team page" },
    { url: `${cleanUrl}/people`, priority: 3, description: "People page" },
    { url: `${cleanUrl}/portfolio`, priority: 4, description: "Portfolio page" },
    { url: `${cleanUrl}/investments`, priority: 4, description: "Investments page" },
    { url: `${cleanUrl}/companies`, priority: 4, description: "Companies page" },
    { url: `${cleanUrl}/focus`, priority: 5, description: "Focus page" },
    { url: `${cleanUrl}/investment-focus`, priority: 5, description: "Investment Focus page" },
    { url: `${cleanUrl}/thesis`, priority: 5, description: "Thesis page" },
    { url: `${cleanUrl}/strategy`, priority: 5, description: "Strategy page" },
  ];
}

/**
 * Fetch and extract text from a URL
 */
export async function fetchAndExtractText(url: string): Promise<{ text: string; success: boolean }> {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    const $ = cheerio.load(response.data);
    
    // Remove script, style, and other non-content tags
    $("script, style, nav, header, footer, iframe, noscript").remove();
    
    // Extract text
    const text = $("body").text().replace(/\s+/g, " ").trim();
    
    return { text, success: text.length > 100 };
  } catch (error) {
    return { text: "", success: false };
  }
}

/**
 * Try multiple URLs in priority order until successful extraction
 */
export async function waterfallFetch(
  baseUrl: string,
  onProgress?: (message: string) => void,
): Promise<{ text: string; sourceUrl: string; attemptedUrls: string[] }> {
  const sources = generateWaterfallUrls(baseUrl);
  const attemptedUrls: string[] = [];
  
  // Sort by priority
  sources.sort((a, b) => a.priority - b.priority);
  
  for (const source of sources) {
    attemptedUrls.push(source.url);
    onProgress?.(`Trying ${source.description}: ${source.url}`);
    
    const result = await fetchAndExtractText(source.url);
    
    if (result.success) {
      onProgress?.(`Successfully extracted from ${source.description}`);
      return {
        text: result.text,
        sourceUrl: source.url,
        attemptedUrls,
      };
    }
  }
  
  // If all fail, return empty with homepage URL
  return {
    text: "",
    sourceUrl: baseUrl,
    attemptedUrls,
  };
}

/**
 * Combine text from multiple successful sources
 */
export async function waterfallFetchMultiple(
  baseUrl: string,
  maxSources: number = 3,
  onProgress?: (message: string) => void,
): Promise<{ combinedText: string; sourceUrls: string[]; attemptedUrls: string[] }> {
  const sources = generateWaterfallUrls(baseUrl);
  const attemptedUrls: string[] = [];
  const successfulTexts: string[] = [];
  const successfulUrls: string[] = [];
  
  // Sort by priority
  sources.sort((a, b) => a.priority - b.priority);
  
  for (const source of sources) {
    if (successfulTexts.length >= maxSources) break;
    
    attemptedUrls.push(source.url);
    onProgress?.(`Trying ${source.description}: ${source.url}`);
    
    const result = await fetchAndExtractText(source.url);
    
    if (result.success) {
      successfulTexts.push(result.text);
      successfulUrls.push(source.url);
      onProgress?.(`Successfully extracted from ${source.description}`);
    }
  }
  
  return {
    combinedText: successfulTexts.join("\n\n---\n\n"),
    sourceUrls: successfulUrls,
    attemptedUrls,
  };
}
