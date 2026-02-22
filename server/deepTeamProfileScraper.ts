/**
 * Deep Team Member Profile Scraper
 * Detects and scrapes individual team member bio/profile pages for comprehensive data extraction
 */

import * as cheerio from 'cheerio';
import { URL } from 'url';

export interface TeamMemberProfileLink {
  name: string;
  profileUrl: string;
  title?: string;
  thumbnailUrl?: string;
  linkText: string;
  context: string;
}

export interface DeepProfileScrapingResult {
  profileLinks: TeamMemberProfileLink[];
  scrapedProfiles: Array<{
    name: string;
    profileUrl: string;
    content: string | null;
    error?: string;
  }>;
  stats: {
    profileLinksDetected: number;
    profilesScraped: number;
    successfulScrapes: number;
    failedScrapes: number;
  };
}

/**
 * Detect individual team member profile links from team listing page HTML
 */
export function detectTeamMemberProfileLinks(
  html: string,
  baseUrl: string,
  options: {
    maxProfiles?: number;
  } = {}
): TeamMemberProfileLink[] {
  const { maxProfiles = 200 } = options;
  
  const $ = cheerio.load(html);
  const profileLinks: TeamMemberProfileLink[] = [];
  const seenUrls = new Set<string>();
  
  console.log(`[Deep Profile] Detecting individual profile links from team page`);
  
  // Strategy 1: Look for common profile link patterns in team sections
  const teamSelectors = [
    // Common team member card/container patterns
    '.team-member a[href]',
    '.person a[href]',
    '.profile a[href]',
    '.bio a[href]',
    '[class*="team"] [class*="member"] a[href]',
    '[class*="people"] [class*="person"] a[href]',
    '[class*="leadership"] a[href]',
    '[class*="partner"] a[href]',
    
    // Grid/list item patterns
    '.team-grid a[href]',
    '.people-grid a[href]',
    'ul.team li a[href]',
    'ul.people li a[href]',
    
    // Card patterns
    '.card a[href]',
    '[class*="card"] a[href]',
  ];
  
  for (const selector of teamSelectors) {
    $(selector).each((_, elem) => {
      const $link = $(elem);
      const href = $link.attr('href');
      
      if (!href) return;
      
      try {
        // Resolve to absolute URL
        const absoluteUrl = new URL(href, baseUrl).href;
        const parsedUrl = new URL(absoluteUrl);
        
        // Only same-domain links
        const baseHostname = new URL(baseUrl).hostname;
        if (parsedUrl.hostname !== baseHostname) return;
        
        // Skip non-profile URLs
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return;
        
        // Skip files
        if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|doc|docx)$/i.test(parsedUrl.pathname)) return;
        
        // Skip common non-profile pages
        const path = parsedUrl.pathname.toLowerCase();
        if (
          path === '/' ||
          path.includes('/contact') ||
          path.includes('/careers') ||
          path.includes('/jobs') ||
          path.includes('/news') ||
          path.includes('/blog') ||
          path.includes('/portfolio')
        ) return;
        
        // Normalize URL
        const normalizedUrl = `${parsedUrl.origin}${parsedUrl.pathname}`.replace(/\/$/, '');
        
        if (seenUrls.has(normalizedUrl)) return;
        seenUrls.add(normalizedUrl);
        
        // Extract context
        const $container = $link.closest('[class*="team"], [class*="person"], [class*="member"], .card, li');
        const name = $link.text().trim() || $container.find('h2, h3, h4, .name, [class*="name"]').first().text().trim();
        const title = $container.find('.title, [class*="title"], .role, [class*="role"]').first().text().trim();
        const thumbnailUrl = $container.find('img').first().attr('src') || '';
        const context = $container.text().replace(/\s+/g, ' ').trim().substring(0, 200);
        
        // Only add if it looks like a profile link (has a name or is in a team context)
        if (name || context.length > 20) {
          profileLinks.push({
            name,
            profileUrl: normalizedUrl,
            title: title || undefined,
            thumbnailUrl: thumbnailUrl || undefined,
            linkText: $link.text().trim(),
            context,
          });
        }
      } catch (error) {
        // Invalid URL, skip
      }
    });
  }
  
  // Strategy 2: Look for links with profile-like URL patterns
  $('a[href]').each((_, elem) => {
    const $link = $(elem);
    const href = $link.attr('href');
    
    if (!href) return;
    
    try {
      const absoluteUrl = new URL(href, baseUrl).href;
      const parsedUrl = new URL(absoluteUrl);
      
      const baseHostname = new URL(baseUrl).hostname;
      if (parsedUrl.hostname !== baseHostname) return;
      
      const path = parsedUrl.pathname.toLowerCase();
      
      // Profile URL patterns
      const profilePatterns = [
        '/team/',
        '/people/',
        '/person/',
        '/partner/',
        '/leadership/',
        '/bio/',
        '/profile/',
        '/member/',
      ];
      
      const hasProfilePattern = profilePatterns.some(pattern => path.includes(pattern));
      
      if (hasProfilePattern) {
        const normalizedUrl = `${parsedUrl.origin}${parsedUrl.pathname}`.replace(/\/$/, '');
        
        if (seenUrls.has(normalizedUrl)) return;
        seenUrls.add(normalizedUrl);
        
        const $container = $link.closest('div, li, section');
        const name = $link.text().trim() || $container.find('h2, h3, h4').first().text().trim();
        const context = $container.text().replace(/\s+/g, ' ').trim().substring(0, 200);
        
        profileLinks.push({
          name,
          profileUrl: normalizedUrl,
          linkText: $link.text().trim(),
          context,
        });
      }
    } catch (error) {
      // Invalid URL, skip
    }
  });
  
  // Deduplicate and limit
  const uniqueProfiles = Array.from(
    new Map(profileLinks.map(p => [p.profileUrl, p])).values()
  ).slice(0, maxProfiles);
  
  console.log(`[Deep Profile] Detected ${uniqueProfiles.length} individual profile links`);
  
  return uniqueProfiles;
}

/**
 * Scrape individual team member profile pages
 */
export async function scrapeTeamMemberProfiles(
  profileLinks: TeamMemberProfileLink[],
  fetchWebpage: (url: string, useBrowser?: boolean) => Promise<string | null>,
  options: {
    delayBetweenProfiles?: number;
    maxConcurrent?: number;
  } = {}
): Promise<DeepProfileScrapingResult['scrapedProfiles']> {
  const {
    delayBetweenProfiles = 1500, // 1.5 seconds between profiles
    maxConcurrent = 1, // Process one at a time to avoid overwhelming the server
  } = options;
  
  console.log(`[Deep Profile] Starting to scrape ${profileLinks.length} individual profiles`);
  
  const scrapedProfiles: DeepProfileScrapingResult['scrapedProfiles'] = [];
  
  // Process profiles sequentially to be polite
  for (let i = 0; i < profileLinks.length; i++) {
    const profile = profileLinks[i];
    
    // Delay between requests
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenProfiles));
    }
    
    console.log(`[Deep Profile] Scraping profile ${i + 1}/${profileLinks.length}: ${profile.name} (${profile.profileUrl})`);
    
    try {
      const content = await fetchWebpage(profile.profileUrl, true);
      
      if (content) {
        scrapedProfiles.push({
          name: profile.name,
          profileUrl: profile.profileUrl,
          content,
        });
        console.log(`[Deep Profile] ✅ Successfully scraped profile for ${profile.name}`);
      } else {
        scrapedProfiles.push({
          name: profile.name,
          profileUrl: profile.profileUrl,
          content: null,
          error: 'Failed to fetch content',
        });
        console.log(`[Deep Profile] ❌ Failed to scrape profile for ${profile.name}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      scrapedProfiles.push({
        name: profile.name,
        profileUrl: profile.profileUrl,
        content: null,
        error: errorMsg,
      });
      console.log(`[Deep Profile] ❌ Error scraping profile for ${profile.name}: ${errorMsg}`);
    }
  }
  
  const successCount = scrapedProfiles.filter(p => p.content !== null).length;
  const failCount = scrapedProfiles.filter(p => p.content === null).length;
  
  console.log(`[Deep Profile] Completed scraping ${profileLinks.length} profiles:`);
  console.log(`  - Successful: ${successCount}`);
  console.log(`  - Failed: ${failCount}`);
  
  return scrapedProfiles;
}

/**
 * Aggregate content from team listing page + individual profile pages
 */
export function aggregateTeamContent(
  listingPageContent: string,
  scrapedProfiles: DeepProfileScrapingResult['scrapedProfiles']
): string {
  const parts: string[] = [];
  
  // Add listing page content
  parts.push('=== TEAM LISTING PAGE ===');
  parts.push(listingPageContent);
  parts.push('');
  
  // Add individual profile pages
  const successfulProfiles = scrapedProfiles.filter(p => p.content !== null);
  
  if (successfulProfiles.length > 0) {
    parts.push('=== INDIVIDUAL TEAM MEMBER PROFILES ===');
    parts.push('');
    
    successfulProfiles.forEach(profile => {
      parts.push(`--- Profile: ${profile.name} (${profile.profileUrl}) ---`);
      parts.push(profile.content!);
      parts.push('');
    });
  }
  
  return parts.join('\n');
}

/**
 * Main function: Deep scrape team members with individual profile pages
 */
export async function deepScrapeTeamMembers(
  teamListingHtml: string,
  baseUrl: string,
  fetchWebpage: (url: string, useBrowser?: boolean) => Promise<string | null>,
  options: {
    maxProfiles?: number;
    delayBetweenProfiles?: number;
    enabled?: boolean;
  } = {}
): Promise<DeepProfileScrapingResult> {
  const {
    maxProfiles = 200,
    delayBetweenProfiles = 1500,
    enabled = true,
  } = options;
  
  if (!enabled) {
    console.log(`[Deep Profile] Deep scraping disabled, skipping`);
    return {
      profileLinks: [],
      scrapedProfiles: [],
      stats: {
        profileLinksDetected: 0,
        profilesScraped: 0,
        successfulScrapes: 0,
        failedScrapes: 0,
      },
    };
  }
  
  console.log(`[Deep Profile] Starting deep team member profile scraping`);
  console.log(`[Deep Profile] Max profiles: ${maxProfiles}`);
  console.log(`[Deep Profile] Delay between profiles: ${delayBetweenProfiles}ms`);
  
  // Step 1: Detect profile links
  const profileLinks = detectTeamMemberProfileLinks(teamListingHtml, baseUrl, { maxProfiles });
  
  if (profileLinks.length === 0) {
    console.log(`[Deep Profile] No individual profile links detected, skipping deep scraping`);
    return {
      profileLinks: [],
      scrapedProfiles: [],
      stats: {
        profileLinksDetected: 0,
        profilesScraped: 0,
        successfulScrapes: 0,
        failedScrapes: 0,
      },
    };
  }
  
  // Step 2: Scrape individual profiles
  const scrapedProfiles = await scrapeTeamMemberProfiles(profileLinks, fetchWebpage, {
    delayBetweenProfiles,
    maxConcurrent: 1,
  });
  
  // Step 3: Calculate stats
  const stats = {
    profileLinksDetected: profileLinks.length,
    profilesScraped: scrapedProfiles.length,
    successfulScrapes: scrapedProfiles.filter(p => p.content !== null).length,
    failedScrapes: scrapedProfiles.filter(p => p.content === null).length,
  };
  
  console.log(`[Deep Profile] Deep scraping complete:`);
  console.log(`  - Profile links detected: ${stats.profileLinksDetected}`);
  console.log(`  - Profiles scraped: ${stats.profilesScraped}`);
  console.log(`  - Successful: ${stats.successfulScrapes}`);
  console.log(`  - Failed: ${stats.failedScrapes}`);
  
  return {
    profileLinks,
    scrapedProfiles,
    stats,
  };
}
