/**
 * Recursive Scraper
 * 
 * Orchestrates LLM-driven recursive exploration of VC firm websites.
 * 
 * Workflow:
 * 1. Fetch homepage via Jina
 * 2. LLM analyzes page → extracts data + suggests URLs to explore
 * 3. For each suggested URL (prioritized):
 *    - Fetch via Jina
 *    - LLM analyzes → more data + more URLs
 * 4. Repeat until:
 *    - No new URLs suggested
 *    - Max depth reached
 *    - Max pages limit reached
 * 5. Deduplicate and return all collected data
 */

import {
  analyzePageWithLLM,
  analyzeProfilePageWithLLM,
  ExtractedTeamMember,
  ExtractedPortfolioCompany,
  ExtractedFirmData,
  SuggestedUrl,
  PageAnalysisResult
} from './llmPageAnalyzer';
import { fetchViaJina } from './jinaFetcher';
import { type ScrapeProfile, VC_PROFILE } from './scrapeProfile';

export interface RecursiveScrapingConfig {
  maxDepth: number;           // Maximum exploration depth (default: 3)
  maxPages: number;           // Maximum total pages to scrape (default: 20)
  maxProfilePages: number;    // Maximum individual profile pages (default: 50)
  delayBetweenPages: number;  // Delay in ms between page fetches (default: 1000)
  goal: 'team' | 'portfolio' | 'all';  // What data to prioritize
  enableDeepProfiles: boolean; // Whether to follow individual profile links
  onProgress?: (message: string, stats: ScrapingStats) => void;
  /** Scraping profile — controls terminology and what to extract (default: VC_PROFILE) */
  profile?: ScrapeProfile;
}

export interface ScrapingStats {
  pagesVisited: number;
  pagesRemaining: number;
  teamMembersFound: number;
  portfolioCompaniesFound: number;
  currentDepth: number;
  currentUrl: string;
}

export interface RecursiveScrapingResult {
  success: boolean;
  firmName: string;
  websiteUrl: string;
  
  // Collected data (deduplicated)
  teamMembers: ExtractedTeamMember[];
  portfolioCompanies: ExtractedPortfolioCompany[];
  firmDescription: string;
  firmData?: ExtractedFirmData;  // NEW: Structured firm data (investment thesis, AUM, etc.)
  
  // Exploration stats
  stats: {
    totalPagesVisited: number;
    teamPagesVisited: number;
    profilePagesVisited: number;
    portfolioPagesVisited: number;
    maxDepthReached: number;
    urlsDiscovered: number;
    urlsSkipped: number;
  };
  
  // Debug info
  visitedUrls: string[];
  errors: string[];
}

const DEFAULT_CONFIG: RecursiveScrapingConfig = {
  maxDepth: 3,
  maxPages: 20,
  maxProfilePages: 50,
  delayBetweenPages: 1000,
  goal: 'all',
  enableDeepProfiles: true
};

/**
 * Main entry point for recursive scraping
 */
export async function scrapeRecursively(
  firmName: string,
  websiteUrl: string,
  fetchWebpage: (url: string, useBrowser?: boolean) => Promise<string | null>,
  config: Partial<RecursiveScrapingConfig> = {}
): Promise<RecursiveScrapingResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[RecursiveScraper] Starting for: ${firmName}`);
  console.log(`[RecursiveScraper] Website: ${websiteUrl}`);
  console.log(`[RecursiveScraper] Config: maxDepth=${cfg.maxDepth}, maxPages=${cfg.maxPages}, goal=${cfg.goal}`);
  console.log(`${'='.repeat(60)}\n`);
  
  const result: RecursiveScrapingResult = {
    success: false,
    firmName,
    websiteUrl,
    teamMembers: [],
    portfolioCompanies: [],
    firmDescription: '',
    stats: {
      totalPagesVisited: 0,
      teamPagesVisited: 0,
      profilePagesVisited: 0,
      portfolioPagesVisited: 0,
      maxDepthReached: 0,
      urlsDiscovered: 0,
      urlsSkipped: 0
    },
    visitedUrls: [],
    errors: []
  };
  
  // URL queue with priority (high priority first)
  const urlQueue: Array<{ url: string; depth: number; priority: 'high' | 'medium' | 'low'; expectedContent: string }> = [];
  const visitedUrls = new Set<string>();
  const profileUrlQueue: Array<{ url: string; personName: string }> = [];
  
  // Normalize and add homepage to queue
  const normalizedHomepage = normalizeUrl(websiteUrl);
  urlQueue.push({ 
    url: normalizedHomepage, 
    depth: 0, 
    priority: 'high',
    expectedContent: 'homepage'
  });
  
  // Process URL queue
  while (urlQueue.length > 0 && result.stats.totalPagesVisited < cfg.maxPages) {
    // Sort by priority (high first) then by depth (shallow first)
    urlQueue.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      }
      return a.depth - b.depth;
    });
    
    const current = urlQueue.shift()!;
    
    // Skip if already visited
    if (visitedUrls.has(current.url)) {
      result.stats.urlsSkipped++;
      continue;
    }
    
    // Skip if max depth exceeded
    if (current.depth > cfg.maxDepth) {
      result.stats.urlsSkipped++;
      continue;
    }
    
    // Mark as visited
    visitedUrls.add(current.url);
    result.visitedUrls.push(current.url);
    result.stats.totalPagesVisited++;
    result.stats.maxDepthReached = Math.max(result.stats.maxDepthReached, current.depth);
    
    // Progress callback
    cfg.onProgress?.(`Analyzing: ${current.url}`, {
      pagesVisited: result.stats.totalPagesVisited,
      pagesRemaining: urlQueue.length,
      teamMembersFound: result.teamMembers.length,
      portfolioCompaniesFound: result.portfolioCompanies.length,
      currentDepth: current.depth,
      currentUrl: current.url
    });
    
    console.log(`\n[RecursiveScraper] Processing (${result.stats.totalPagesVisited}/${cfg.maxPages}): ${current.url}`);
    console.log(`[RecursiveScraper] Depth: ${current.depth}, Expected: ${current.expectedContent}`);
    
    // Fetch page content
    let pageContent: string | null = null;
    try {
      // Add delay between requests
      if (result.stats.totalPagesVisited > 1) {
        await sleep(cfg.delayBetweenPages);
      }
      
      pageContent = await fetchWebpage(current.url, true);
      
      if (!pageContent || pageContent.length < 100) {
        console.log(`[RecursiveScraper] ❌ Failed to fetch or empty content: ${current.url}`);
        result.errors.push(`Failed to fetch: ${current.url}`);
        continue;
      }
      
      console.log(`[RecursiveScraper] ✅ Fetched ${pageContent.length} chars`);
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[RecursiveScraper] ❌ Error fetching ${current.url}:`, errorMsg);
      result.errors.push(`Error fetching ${current.url}: ${errorMsg}`);
      continue;
    }
    
    // Analyze page with LLM
    try {
      const analysis = await analyzePageWithLLM(
        pageContent,
        current.url,
        firmName,
        {
          visitedUrls: Array.from(visitedUrls),
          currentDepth: current.depth,
          maxDepth: cfg.maxDepth,
          goal: cfg.goal,
          profile: cfg.profile ?? VC_PROFILE,
        }
      );
      
      // Track page type stats
      if (analysis.pageType === 'team_listing') result.stats.teamPagesVisited++;
      if (analysis.pageType === 'individual_profile') result.stats.profilePagesVisited++;
      if (analysis.pageType === 'portfolio') result.stats.portfolioPagesVisited++;
      
      // Collect firm description (prefer first non-empty)
      if (analysis.firmDescription && !result.firmDescription) {
        result.firmDescription = analysis.firmDescription;
      }
      
      // Collect firm data (merge from multiple pages, prefer non-empty values)
      if (analysis.firmData) {
        if (!result.firmData) {
          result.firmData = analysis.firmData;
        } else {
          // Merge: prefer existing non-empty values, but fill in gaps
          result.firmData = {
            description: result.firmData.description || analysis.firmData.description,
            investmentThesis: result.firmData.investmentThesis || analysis.firmData.investmentThesis,
            aum: result.firmData.aum || analysis.firmData.aum,
            investmentStages: (result.firmData.investmentStages?.length || 0) > 0 
              ? result.firmData.investmentStages 
              : analysis.firmData.investmentStages,
            sectorFocus: (result.firmData.sectorFocus?.length || 0) > 0 
              ? result.firmData.sectorFocus 
              : analysis.firmData.sectorFocus,
            geographicFocus: (result.firmData.geographicFocus?.length || 0) > 0 
              ? result.firmData.geographicFocus 
              : analysis.firmData.geographicFocus,
            foundedYear: result.firmData.foundedYear || analysis.firmData.foundedYear,
            headquarters: result.firmData.headquarters || analysis.firmData.headquarters
          };
        }
        console.log(`[RecursiveScraper] Collected firm data: AUM=${result.firmData.aum || 'N/A'}, Stages=${result.firmData.investmentStages?.join(', ') || 'N/A'}`);
      }
      
      // Collect team members (will dedupe later)
      if (analysis.teamMembers.length > 0) {
        console.log(`[RecursiveScraper] Found ${analysis.teamMembers.length} team members`);
        
        for (const member of analysis.teamMembers) {
          // Add to results
          result.teamMembers.push(member);
          
          // Queue profile page for deep scraping if enabled
          if (cfg.enableDeepProfiles && member.profileUrl && !visitedUrls.has(member.profileUrl)) {
            profileUrlQueue.push({
              url: member.profileUrl,
              personName: member.name
            });
          }
        }
      }
      
      // Collect portfolio companies (will dedupe later)
      if (analysis.portfolioCompanies.length > 0) {
        console.log(`[RecursiveScraper] Found ${analysis.portfolioCompanies.length} portfolio companies`);
        result.portfolioCompanies.push(...analysis.portfolioCompanies);
      }
      
      // Add suggested URLs to queue
      if (analysis.suggestedUrls.length > 0) {
        console.log(`[RecursiveScraper] LLM suggested ${analysis.suggestedUrls.length} URLs to explore`);
        result.stats.urlsDiscovered += analysis.suggestedUrls.length;
        
        for (const suggested of analysis.suggestedUrls) {
          if (!visitedUrls.has(suggested.url)) {
            urlQueue.push({
              url: suggested.url,
              depth: current.depth + 1,
              priority: suggested.priority,
              expectedContent: suggested.expectedContent
            });
            console.log(`  → Queued: ${suggested.url} (${suggested.priority}, ${suggested.expectedContent})`);
          }
        }
      }
      
      // Handle "Load More" if detected
      if (analysis.hasMoreContent && analysis.loadMoreSelector) {
        console.log(`[RecursiveScraper] Page has more content (${analysis.loadMoreSelector})`);
        // Note: Actual "Load More" clicking would require browser automation
        // For now, we log it as a limitation
        result.errors.push(`Page ${current.url} has "Load More" content that wasn't fully loaded`);
      }
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[RecursiveScraper] ❌ Error analyzing ${current.url}:`, errorMsg);
      result.errors.push(`Error analyzing ${current.url}: ${errorMsg}`);
    }
  }
  
  // Process individual profile pages (if enabled and we have capacity)
  if (cfg.enableDeepProfiles && profileUrlQueue.length > 0) {
    console.log(`\n[RecursiveScraper] Processing ${profileUrlQueue.length} individual profile pages...`);
    
    const profilesToProcess = profileUrlQueue.slice(0, cfg.maxProfilePages);
    
    for (const profile of profilesToProcess) {
      if (visitedUrls.has(profile.url)) continue;
      
      visitedUrls.add(profile.url);
      result.visitedUrls.push(profile.url);
      result.stats.profilePagesVisited++;
      
      cfg.onProgress?.(`Analyzing profile: ${profile.personName}`, {
        pagesVisited: result.stats.totalPagesVisited + result.stats.profilePagesVisited,
        pagesRemaining: profilesToProcess.length - result.stats.profilePagesVisited,
        teamMembersFound: result.teamMembers.length,
        portfolioCompaniesFound: result.portfolioCompanies.length,
        currentDepth: cfg.maxDepth + 1,
        currentUrl: profile.url
      });
      
      try {
        await sleep(cfg.delayBetweenPages);
        
        const pageContent = await fetchWebpage(profile.url, true);
        
        if (pageContent && pageContent.length > 100) {
          const profileData = await analyzeProfilePageWithLLM(
            pageContent,
            profile.url,
            profile.personName,
            firmName
          );
          
          if (profileData) {
            // Merge profile data with existing team member
            const existingIndex = result.teamMembers.findIndex(
              m => normalizeString(m.name) === normalizeString(profile.personName)
            );
            
            if (existingIndex >= 0) {
              // Update existing member with richer data
              const existing = result.teamMembers[existingIndex];
              result.teamMembers[existingIndex] = {
                ...existing,
                title: profileData.title || existing.title,
                jobFunction: profileData.jobFunction || existing.jobFunction,
                specialization: profileData.specialization || existing.specialization,
                email: profileData.email || existing.email,
                linkedinUrl: profileData.linkedinUrl || existing.linkedinUrl,
                profileUrl: profile.url,
                portfolioCompanies: profileData.portfolioCompanies?.length 
                  ? profileData.portfolioCompanies 
                  : existing.portfolioCompanies
              };
              console.log(`[RecursiveScraper] ✅ Enriched profile: ${profile.personName}`);
            } else {
              // Add as new member
              result.teamMembers.push(profileData);
              console.log(`[RecursiveScraper] ✅ Added new profile: ${profile.personName}`);
            }
          }
        }
      } catch (error) {
        console.error(`[RecursiveScraper] Error processing profile ${profile.url}:`, error);
      }
    }
  }
  
  // Deduplicate results
  console.log(`\n[RecursiveScraper] Deduplicating results...`);
  console.log(`[RecursiveScraper] Before dedup: ${result.teamMembers.length} team members, ${result.portfolioCompanies.length} portfolio companies`);
  
  result.teamMembers = deduplicateTeamMembers(result.teamMembers);
  result.portfolioCompanies = deduplicatePortfolioCompanies(result.portfolioCompanies);
  
  console.log(`[RecursiveScraper] After dedup: ${result.teamMembers.length} team members, ${result.portfolioCompanies.length} portfolio companies`);
  
  result.success = result.teamMembers.length > 0 || result.portfolioCompanies.length > 0;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[RecursiveScraper] Completed for: ${firmName}`);
  console.log(`[RecursiveScraper] Success: ${result.success}`);
  console.log(`[RecursiveScraper] Pages visited: ${result.stats.totalPagesVisited}`);
  console.log(`[RecursiveScraper] Team members: ${result.teamMembers.length}`);
  console.log(`[RecursiveScraper] Portfolio companies: ${result.portfolioCompanies.length}`);
  console.log(`[RecursiveScraper] Errors: ${result.errors.length}`);
  console.log(`${'='.repeat(60)}\n`);
  
  return result;
}

/**
 * Deduplicate team members by normalized name
 * Merges data from multiple sources, preferring non-empty values
 */
function deduplicateTeamMembers(members: ExtractedTeamMember[]): ExtractedTeamMember[] {
  const memberMap = new Map<string, ExtractedTeamMember>();
  
  for (const member of members) {
    const key = normalizeString(member.name);
    
    if (!key) continue; // Skip empty names
    
    const existing = memberMap.get(key);
    
    if (!existing) {
      memberMap.set(key, { ...member });
    } else {
      // Merge: prefer non-empty values, concatenate arrays
      memberMap.set(key, {
        name: existing.name || member.name,
        title: existing.title || member.title,
        jobFunction: existing.jobFunction || member.jobFunction,
        specialization: existing.specialization || member.specialization,
        email: existing.email || member.email,
        linkedinUrl: existing.linkedinUrl || member.linkedinUrl,
        profileUrl: existing.profileUrl || member.profileUrl,
        portfolioCompanies: mergeArrays(existing.portfolioCompanies, member.portfolioCompanies)
      });
    }
  }
  
  return Array.from(memberMap.values());
}

/**
 * Deduplicate portfolio companies by normalized name
 */
function deduplicatePortfolioCompanies(companies: ExtractedPortfolioCompany[]): ExtractedPortfolioCompany[] {
  const companyMap = new Map<string, ExtractedPortfolioCompany>();
  
  for (const company of companies) {
    const key = normalizeString(company.name);
    
    if (!key) continue;
    
    const existing = companyMap.get(key);
    
    if (!existing) {
      companyMap.set(key, { ...company });
    } else {
      // Merge: prefer non-empty values
      companyMap.set(key, {
        name: existing.name || company.name,
        description: existing.description || company.description,
        sector: existing.sector || company.sector,
        stage: existing.stage || company.stage,
        url: existing.url || company.url
      });
    }
  }
  
  return Array.from(companyMap.values());
}

/**
 * Normalize string for comparison
 */
function normalizeString(str: string | undefined): string {
  if (!str) return '';
  return str.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Normalize URL for comparison
 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '').toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/$/, '');
  }
}

/**
 * Merge two arrays, removing duplicates
 */
function mergeArrays(arr1?: string[], arr2?: string[]): string[] {
  const set = new Set<string>();
  
  for (const item of arr1 || []) {
    if (item) set.add(item.trim());
  }
  
  for (const item of arr2 || []) {
    if (item) set.add(item.trim());
  }
  
  return Array.from(set);
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
