/**
 * Comprehensive Multi-Page Scraping Orchestrator
 * Discovers and scrapes ALL relevant pages from a VC firm's website
 * Aggregates data from team, portfolio, about, and other pages
 */

import { discoverRelevantURLs, DiscoveredURL, analyzeDiscoveredURLs, logDiscoveryStats, generateStandardURLs } from './multiUrlDiscovery';

export interface ComprehensiveScrapingResult {
  success: boolean;
  homepageContent: string | null;
  additionalPages: Array<{
    url: string;
    category: string;
    content: string | null;
    error?: string;
  }>;
  stats: {
    totalPagesDiscovered: number;
    totalPagesScraped: number;
    successfulScrapes: number;
    failedScrapes: number;
    teamPagesScraped: number;
    portfolioPagesScraped: number;
    aboutPagesScraped: number;
  };
}

/**
 * Scrape multiple pages from a VC firm's website comprehensively
 * 
 * @param firmName - Name of the firm
 * @param homepageUrl - Homepage URL
 * @param fetchWebpage - Function to fetch webpage content (from vcEnrichment)
 * @param options - Scraping options
 */
export async function scrapeComprehensively(
  firmName: string,
  homepageUrl: string,
  fetchWebpage: (url: string, useBrowser?: boolean) => Promise<string | null>,
  options: {
    maxTeamPages?: number;
    maxPortfolioPages?: number;
    maxAboutPages?: number;
    delayBetweenPages?: number; // ms
  } = {}
): Promise<ComprehensiveScrapingResult> {
  const {
    maxTeamPages = 5,
    maxPortfolioPages = 3,
    maxAboutPages = 2,
    delayBetweenPages = 1000, // 1 second delay between pages
  } = options;

  console.log(`[Comprehensive Scraper] Starting for ${firmName} (${homepageUrl})`);

  // Step 1: Fetch homepage
  console.log(`[Comprehensive Scraper] Fetching homepage: ${homepageUrl}`);
  const homepageContent = await fetchWebpage(homepageUrl, true);

  if (!homepageContent) {
    console.log(`[Comprehensive Scraper] Failed to fetch homepage for ${firmName}`);
    return {
      success: false,
      homepageContent: null,
      additionalPages: [],
      stats: {
        totalPagesDiscovered: 0,
        totalPagesScraped: 0,
        successfulScrapes: 0,
        failedScrapes: 1,
        teamPagesScraped: 0,
        portfolioPagesScraped: 0,
        aboutPagesScraped: 0,
      },
    };
  }

  // Step 2: Discover relevant URLs from homepage
  console.log(`[Comprehensive Scraper] Discovering relevant URLs from homepage`);
  let discoveredURLs = discoverRelevantURLs(homepageContent, homepageUrl, {
    maxTeamPages,
    maxPortfolioPages,
    maxAboutPages,
    includeNews: false,
    includeOther: false,
  });

  // Fallback: If no URLs discovered, try standard patterns
  if (discoveredURLs.length === 0) {
    console.log(`[Comprehensive Scraper] No URLs discovered from homepage, trying standard patterns`);
    const standardURLs = generateStandardURLs(homepageUrl);
    discoveredURLs = standardURLs.slice(0, maxTeamPages + maxPortfolioPages + maxAboutPages);
    console.log(`[Comprehensive Scraper] Generated ${discoveredURLs.length} standard URLs to try`);
  }

  const discoveryStats = analyzeDiscoveredURLs(discoveredURLs);
  logDiscoveryStats(firmName, discoveryStats);

  // Step 3: Scrape additional pages
  const additionalPages: ComprehensiveScrapingResult['additionalPages'] = [];
  let successfulScrapes = 1; // Homepage already scraped
  let failedScrapes = 0;
  let teamPagesScraped = 0;
  let portfolioPagesScraped = 0;
  let aboutPagesScraped = 0;

  for (const discovered of discoveredURLs) {
    // Delay between requests to be polite
    if (additionalPages.length > 0) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenPages));
    }

    console.log(`[Comprehensive Scraper] Fetching ${discovered.category} page: ${discovered.url}`);

    try {
      const content = await fetchWebpage(discovered.url, true);

      if (content) {
        additionalPages.push({
          url: discovered.url,
          category: discovered.category,
          content,
        });
        successfulScrapes++;

        // Track by category
        if (discovered.category === 'team') teamPagesScraped++;
        else if (discovered.category === 'portfolio') portfolioPagesScraped++;
        else if (discovered.category === 'about') aboutPagesScraped++;

        console.log(`[Comprehensive Scraper] ✅ Successfully scraped ${discovered.category} page`);
      } else {
        additionalPages.push({
          url: discovered.url,
          category: discovered.category,
          content: null,
          error: 'Failed to fetch content',
        });
        failedScrapes++;
        console.log(`[Comprehensive Scraper] ❌ Failed to scrape ${discovered.category} page`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      additionalPages.push({
        url: discovered.url,
        category: discovered.category,
        content: null,
        error: errorMsg,
      });
      failedScrapes++;
      console.log(`[Comprehensive Scraper] ❌ Error scraping ${discovered.category} page: ${errorMsg}`);
    }
  }

  // Step 4: Return aggregated results
  const stats = {
    totalPagesDiscovered: discoveredURLs.length,
    totalPagesScraped: successfulScrapes + failedScrapes,
    successfulScrapes,
    failedScrapes,
    teamPagesScraped,
    portfolioPagesScraped,
    aboutPagesScraped,
  };

  console.log(`[Comprehensive Scraper] Completed for ${firmName}:`);
  console.log(`  Total pages scraped: ${stats.totalPagesScraped}`);
  console.log(`  Successful: ${stats.successfulScrapes}`);
  console.log(`  Failed: ${stats.failedScrapes}`);
  console.log(`  Team pages: ${stats.teamPagesScraped}`);
  console.log(`  Portfolio pages: ${stats.portfolioPagesScraped}`);
  console.log(`  About pages: ${stats.aboutPagesScraped}`);

  return {
    success: true,
    homepageContent,
    additionalPages,
    stats,
  };
}

/**
 * Aggregate all scraped content into a single string for extraction
 */
export function aggregateAllContent(result: ComprehensiveScrapingResult): string {
  const parts: string[] = [];

  // Add homepage content
  if (result.homepageContent) {
    parts.push('=== HOMEPAGE ===');
    parts.push(result.homepageContent);
    parts.push('');
  }

  // Add additional pages by category
  const teamPages = result.additionalPages.filter(p => p.category === 'team' && p.content);
  if (teamPages.length > 0) {
    parts.push('=== TEAM PAGES ===');
    teamPages.forEach(page => {
      parts.push(`--- ${page.url} ---`);
      parts.push(page.content!);
      parts.push('');
    });
  }

  const portfolioPages = result.additionalPages.filter(p => p.category === 'portfolio' && p.content);
  if (portfolioPages.length > 0) {
    parts.push('=== PORTFOLIO PAGES ===');
    portfolioPages.forEach(page => {
      parts.push(`--- ${page.url} ---`);
      parts.push(page.content!);
      parts.push('');
    });
  }

  const aboutPages = result.additionalPages.filter(p => p.category === 'about' && p.content);
  if (aboutPages.length > 0) {
    parts.push('=== ABOUT PAGES ===');
    aboutPages.forEach(page => {
      parts.push(`--- ${page.url} ---`);
      parts.push(page.content!);
      parts.push('');
    });
  }

  return parts.join('\n');
}

/**
 * Get team-specific content only (for team member extraction)
 */
export function getTeamSpecificContent(result: ComprehensiveScrapingResult): string {
  const parts: string[] = [];

  // Add homepage content (may contain team info)
  if (result.homepageContent) {
    parts.push('=== HOMEPAGE ===');
    parts.push(result.homepageContent);
    parts.push('');
  }

  // Add team pages
  const teamPages = result.additionalPages.filter(p => p.category === 'team' && p.content);
  if (teamPages.length > 0) {
    parts.push('=== TEAM PAGES ===');
    teamPages.forEach(page => {
      parts.push(`--- ${page.url} ---`);
      parts.push(page.content!);
      parts.push('');
    });
  }

  return parts.join('\n');
}

/**
 * Get portfolio-specific content only (for portfolio extraction)
 */
export function getPortfolioSpecificContent(result: ComprehensiveScrapingResult): string {
  const parts: string[] = [];

  // Add homepage content (may contain portfolio info)
  if (result.homepageContent) {
    parts.push('=== HOMEPAGE ===');
    parts.push(result.homepageContent);
    parts.push('');
  }

  // Add portfolio pages
  const portfolioPages = result.additionalPages.filter(p => p.category === 'portfolio' && p.content);
  if (portfolioPages.length > 0) {
    parts.push('=== PORTFOLIO PAGES ===');
    portfolioPages.forEach(page => {
      parts.push(`--- ${page.url} ---`);
      parts.push(page.content!);
      parts.push('');
    });
  }

  return parts.join('\n');
}
