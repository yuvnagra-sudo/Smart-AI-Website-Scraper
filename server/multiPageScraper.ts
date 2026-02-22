/**
 * Multi-Page Scraper
 * Scrapes LinkedIn URLs from multiple pages on VC firm websites
 */

import axios from "axios";
import * as cheerio from "cheerio";
import { ExtractedLinkedInURL } from "./improvedLinkedInExtractor";

interface PageToScrape {
  url: string;
  pageType: string;
}

/**
 * Generate list of pages to scrape for LinkedIn URLs
 */
export function generatePagesToScrape(baseUrl: string): PageToScrape[] {
  const pages: PageToScrape[] = [];
  
  // Common page patterns for VC firm websites
  const patterns = [
    { path: "/team", type: "team" },
    { path: "/people", type: "team" },
    { path: "/our-team", type: "team" },
    { path: "/about/team", type: "team" },
    { path: "/leadership", type: "leadership" },
    { path: "/partners", type: "team" },
    { path: "/about", type: "about" },
    { path: "/about-us", type: "about" },
    { path: "/who-we-are", type: "about" },
    { path: "/our-people", type: "team" },
  ];
  
  for (const pattern of patterns) {
    pages.push({
      url: `${baseUrl}${pattern.path}`,
      pageType: pattern.type,
    });
  }
  
  return pages;
}

/**
 * Fetch a webpage with error handling
 */
async function fetchPage(url: string): Promise<string | null> {
  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 10000,
      maxRedirects: 5,
    });
    
    if (response.status === 200) {
      return response.data;
    }
  } catch (error: any) {
    // Silently fail - page might not exist
    if (error.response?.status !== 404) {
      console.log(`[Multi-Page] Could not fetch ${url}: ${error.message}`);
    }
  }
  
  return null;
}

/**
 * Extract LinkedIn URLs from HTML with structured data support
 */
export function extractLinkedInURLsWithStructuredData(html: string): ExtractedLinkedInURL[] {
  const $ = cheerio.load(html);
  const linkedinUrls: ExtractedLinkedInURL[] = [];
  const seenUrls = new Set<string>();
  
  // Strategy 1: Regular <a> tags
  $('a[href*="linkedin.com/in/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    
    let cleanUrl = href.split("?")[0].split("#")[0].replace(/\/$/, "");
    
    if (cleanUrl.startsWith("//")) {
      cleanUrl = "https:" + cleanUrl;
    } else if (cleanUrl.startsWith("/")) {
      cleanUrl = "https://www.linkedin.com" + cleanUrl;
    } else if (!cleanUrl.startsWith("http")) {
      cleanUrl = "https://" + cleanUrl;
    }
    
    if (seenUrls.has(cleanUrl)) return;
    seenUrls.add(cleanUrl);
    
    const $el = $(el);
    const $parent = $el.closest("div, li, section, article, td");
    const nearbyText = $parent.text().replace(/\s+/g, " ").trim();
    const $container = $el.closest("section, article, div[class*='team'], div[class*='member']");
    const context = $container.text().replace(/\s+/g, " ").trim();
    
    linkedinUrls.push({
      url: cleanUrl,
      context: context.substring(0, 500),
      nearbyText: nearbyText.substring(0, 200),
      elementType: $parent.prop("tagName") || "unknown",
    });
  });
  
  // Strategy 2: Data attributes
  $('[data-linkedin], [data-social-linkedin], [data-linkedin-url]').each((_, el) => {
    const $el = $(el);
    const linkedinUrl = $el.attr("data-linkedin") || $el.attr("data-social-linkedin") || $el.attr("data-linkedin-url");
    
    if (!linkedinUrl || !linkedinUrl.includes("linkedin.com/in/")) return;
    
    let cleanUrl = linkedinUrl.split("?")[0].split("#")[0].replace(/\/$/, "");
    if (!cleanUrl.startsWith("http")) {
      cleanUrl = "https://" + cleanUrl;
    }
    
    if (seenUrls.has(cleanUrl)) return;
    seenUrls.add(cleanUrl);
    
    const nearbyText = $el.text().replace(/\s+/g, " ").trim();
    
    linkedinUrls.push({
      url: cleanUrl,
      context: nearbyText.substring(0, 500),
      nearbyText: nearbyText.substring(0, 200),
      elementType: "data-attribute",
    });
  });
  
  // Strategy 3: JSON-LD structured data
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      
      // Handle Person schema
      if (data["@type"] === "Person" && data.sameAs) {
        const sameAs = Array.isArray(data.sameAs) ? data.sameAs : [data.sameAs];
        for (const url of sameAs) {
          if (typeof url === 'string' && url.includes('linkedin.com/in/')) {
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);
            
            linkedinUrls.push({
              url,
              context: data.name || "",
              nearbyText: `${data.name || ""} - ${data.jobTitle || ""}`.trim(),
              elementType: "json-ld",
            });
          }
        }
      }
      
      // Handle array of people
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item["@type"] === "Person" && item.sameAs) {
            const sameAs = Array.isArray(item.sameAs) ? item.sameAs : [item.sameAs];
            for (const url of sameAs) {
              if (typeof url === 'string' && url.includes('linkedin.com/in/')) {
                if (seenUrls.has(url)) continue;
                seenUrls.add(url);
                
                linkedinUrls.push({
                  url,
                  context: item.name || "",
                  nearbyText: `${item.name || ""} - ${item.jobTitle || ""}`.trim(),
                  elementType: "json-ld",
                });
              }
            }
          }
        }
      }
    } catch (e) {
      // Invalid JSON, skip
    }
  });
  
  // Strategy 4: Meta tags
  $('meta[property="og:url"], meta[name="twitter:url"]').each((_, el) => {
    const content = $(el).attr("content");
    if (content && content.includes('linkedin.com/in/')) {
      if (seenUrls.has(content)) return;
      seenUrls.add(content);
      
      linkedinUrls.push({
        url: content,
        context: "",
        nearbyText: "",
        elementType: "meta-tag",
      });
    }
  });
  
  return linkedinUrls;
}

/**
 * Scrape multiple pages and aggregate LinkedIn URLs
 */
export async function scrapeMultiplePages(baseUrl: string): Promise<ExtractedLinkedInURL[]> {
  console.log(`[Multi-Page] Starting multi-page scrape for ${baseUrl}`);
  
  const pagesToScrape = generatePagesToScrape(baseUrl);
  const allLinkedInUrls: ExtractedLinkedInURL[] = [];
  const seenUrls = new Set<string>();
  
  // Scrape pages in parallel (but limit concurrency)
  const CONCURRENCY = 3;
  for (let i = 0; i < pagesToScrape.length; i += CONCURRENCY) {
    const batch = pagesToScrape.slice(i, i + CONCURRENCY);
    
    const results = await Promise.all(
      batch.map(async (page) => {
        const html = await fetchPage(page.url);
        if (!html) return [];
        
        console.log(`[Multi-Page] Successfully fetched ${page.pageType} page: ${page.url}`);
        return extractLinkedInURLsWithStructuredData(html);
      })
    );
    
    // Aggregate results and deduplicate
    for (const urls of results) {
      for (const urlData of urls) {
        if (!seenUrls.has(urlData.url)) {
          seenUrls.add(urlData.url);
          allLinkedInUrls.push(urlData);
        }
      }
    }
  }
  
  console.log(`[Multi-Page] Found ${allLinkedInUrls.length} unique LinkedIn URLs across all pages`);
  
  return allLinkedInUrls;
}

/**
 * Find individual bio pages and scrape them
 */
export async function findAndScrapeBioPages(baseUrl: string, teamPageHtml: string): Promise<ExtractedLinkedInURL[]> {
  const $ = cheerio.load(teamPageHtml);
  const bioPageUrls: string[] = [];
  
  // Look for links that might be bio pages
  $('a[href*="/team/"], a[href*="/people/"], a[href*="/partner/"], a[href*="/about/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    
    let fullUrl = href;
    if (href.startsWith("/")) {
      fullUrl = baseUrl + href;
    } else if (!href.startsWith("http")) {
      fullUrl = baseUrl + "/" + href;
    }
    
    // Only add if it looks like an individual page (has a name or ID)
    if (fullUrl !== baseUrl && fullUrl.split("/").length > 3) {
      bioPageUrls.push(fullUrl);
    }
  });
  
  console.log(`[Multi-Page] Found ${bioPageUrls.length} potential bio pages`);
  
  // Limit to first 20 bio pages to avoid excessive requests
  const limitedUrls = bioPageUrls.slice(0, 20);
  const allLinkedInUrls: ExtractedLinkedInURL[] = [];
  const seenUrls = new Set<string>();
  
  // Scrape bio pages in parallel
  const CONCURRENCY = 3;
  for (let i = 0; i < limitedUrls.length; i += CONCURRENCY) {
    const batch = limitedUrls.slice(i, i + CONCURRENCY);
    
    const results = await Promise.all(
      batch.map(async (url) => {
        const html = await fetchPage(url);
        if (!html) return [];
        
        return extractLinkedInURLsWithStructuredData(html);
      })
    );
    
    for (const urls of results) {
      for (const urlData of urls) {
        if (!seenUrls.has(urlData.url)) {
          seenUrls.add(urlData.url);
          allLinkedInUrls.push(urlData);
        }
      }
    }
  }
  
  console.log(`[Multi-Page] Found ${allLinkedInUrls.length} LinkedIn URLs from bio pages`);
  
  return allLinkedInUrls;
}
