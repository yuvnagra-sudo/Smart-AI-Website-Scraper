/**
 * Multi-URL Discovery and Scraping System
 * Discovers and scrapes all relevant pages from a VC firm's website
 */

import * as cheerio from 'cheerio';
import { URL } from 'url';

export interface DiscoveredURL {
  url: string;
  category: 'team' | 'portfolio' | 'about' | 'news' | 'contact' | 'other';
  priority: number; // 1 = highest, 5 = lowest
  text: string; // Link text
}

export interface MultiPageContent {
  homepage: string;
  teamPages: string[];
  portfolioPages: string[];
  aboutPages: string[];
  otherPages: string[];
}

/**
 * Extract all internal URLs from HTML or Markdown content
 */
function extractAllLinks(content: string, baseUrl: string): Array<{ url: string; text: string }> {
  // Try to detect if content is markdown (from Jina) or HTML
  const isMarkdown = !content.trim().startsWith('<') && (content.includes('](') || content.includes('# '));
  
  if (isMarkdown) {
    return extractLinksFromMarkdown(content, baseUrl);
  }
  
  return extractLinksFromHTML(content, baseUrl);
}

/**
 * Extract links from markdown content (Jina output)
 */
function extractLinksFromMarkdown(markdown: string, baseUrl: string): Array<{ url: string; text: string }> {
  const links: Array<{ url: string; text: string }> = [];
  const seen = new Set<string>();
  
  // Match markdown links: [text](url)
  const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  
  while ((match = markdownLinkRegex.exec(markdown)) !== null) {
    const text = match[1].trim();
    const href = match[2].trim();
    
    try {
      const absoluteUrl = new URL(href, baseUrl).href;
      const parsedUrl = new URL(absoluteUrl);
      const baseHostname = new URL(baseUrl).hostname;
      
      if (parsedUrl.hostname !== baseHostname) continue;
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') continue;
      if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|doc|docx|xls|xlsx)$/i.test(parsedUrl.pathname)) continue;
      
      const normalizedUrl = `${parsedUrl.origin}${parsedUrl.pathname}`.replace(/\/$/, '');
      
      if (!seen.has(normalizedUrl)) {
        seen.add(normalizedUrl);
        links.push({ url: normalizedUrl, text });
      }
    } catch (error) {
      // Invalid URL, skip
    }
  }
  
  // Also try to extract plain URLs from markdown
  const urlRegex = /https?:\/\/[^\s)]+/g;
  while ((match = urlRegex.exec(markdown)) !== null) {
    const href = match[0];
    
    try {
      const parsedUrl = new URL(href);
      const baseHostname = new URL(baseUrl).hostname;
      
      if (parsedUrl.hostname !== baseHostname) continue;
      if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|doc|docx|xls|xlsx)$/i.test(parsedUrl.pathname)) continue;
      
      const normalizedUrl = `${parsedUrl.origin}${parsedUrl.pathname}`.replace(/\/$/, '');
      
      if (!seen.has(normalizedUrl)) {
        seen.add(normalizedUrl);
        links.push({ url: normalizedUrl, text: '' });
      }
    } catch (error) {
      // Invalid URL, skip
    }
  }
  
  return links;
}

/**
 * Extract links from HTML content
 */
function extractLinksFromHTML(html: string, baseUrl: string): Array<{ url: string; text: string }> {
  const $ = cheerio.load(html);
  const links: Array<{ url: string; text: string }> = [];
  const seen = new Set<string>();

  $('a[href]').each((_, elem) => {
    const href = $(elem).attr('href');
    const text = $(elem).text().trim();

    if (!href) return;

    try {
      // Resolve relative URLs
      const absoluteUrl = new URL(href, baseUrl).href;
      const parsedUrl = new URL(absoluteUrl);

      // Only include same-domain links
      const baseHostname = new URL(baseUrl).hostname;
      if (parsedUrl.hostname !== baseHostname) return;

      // Skip anchors, mailto, tel, etc.
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return;

      // Skip files
      if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|doc|docx|xls|xlsx)$/i.test(parsedUrl.pathname)) return;

      // Normalize URL (remove trailing slash, fragments)
      const normalizedUrl = `${parsedUrl.origin}${parsedUrl.pathname}`.replace(/\/$/, '');

      if (!seen.has(normalizedUrl)) {
        seen.add(normalizedUrl);
        links.push({ url: normalizedUrl, text });
      }
    } catch (error) {
      // Invalid URL, skip
    }
  });

  return links;
}

/**
 * Categorize URLs based on path and link text
 */
export function categorizeURL(url: string, text: string): DiscoveredURL['category'] {
  const urlLower = url.toLowerCase();
  const textLower = text.toLowerCase();

  // Team/People pages (highest priority)
  const teamPatterns = [
    '/team', '/people', '/about-us', '/leadership', '/partners',
    '/our-team', '/meet-the-team', '/management', '/executives',
    '/investment-team', '/professionals'
  ];
  if (teamPatterns.some(p => urlLower.includes(p)) ||
      ['team', 'people', 'leadership', 'partners', 'our team', 'meet the team'].some(p => textLower.includes(p))) {
    return 'team';
  }

  // Portfolio pages
  const portfolioPatterns = [
    '/portfolio', '/companies', '/investments', '/our-portfolio',
    '/portfolio-companies', '/our-companies', '/what-we-invest-in'
  ];
  if (portfolioPatterns.some(p => urlLower.includes(p)) ||
      ['portfolio', 'companies', 'investments', 'our portfolio'].some(p => textLower.includes(p))) {
    return 'portfolio';
  }

  // About pages
  const aboutPatterns = [
    '/about', '/who-we-are', '/our-story', '/mission', '/values',
    '/philosophy', '/approach', '/overview'
  ];
  if (aboutPatterns.some(p => urlLower.includes(p)) ||
      ['about', 'who we are', 'our story', 'mission', 'values', 'philosophy'].some(p => textLower.includes(p))) {
    return 'about';
  }

  // News/Blog pages
  const newsPatterns = [
    '/news', '/blog', '/insights', '/press', '/media', '/articles',
    '/updates', '/announcements'
  ];
  if (newsPatterns.some(p => urlLower.includes(p)) ||
      ['news', 'blog', 'insights', 'press', 'media', 'articles'].some(p => textLower.includes(p))) {
    return 'news';
  }

  // Contact pages
  const contactPatterns = ['/contact', '/get-in-touch', '/reach-us'];
  if (contactPatterns.some(p => urlLower.includes(p)) ||
      ['contact', 'get in touch', 'reach us'].some(p => textLower.includes(p))) {
    return 'contact';
  }

  return 'other';
}

/**
 * Assign priority to URLs based on category
 */
function assignPriority(category: DiscoveredURL['category']): number {
  switch (category) {
    case 'team': return 1;
    case 'portfolio': return 2;
    case 'about': return 3;
    case 'contact': return 4;
    case 'news': return 5;
    case 'other': return 5;
  }
}

/**
 * Discover all relevant URLs from homepage HTML
 */
export function discoverRelevantURLs(
  homepageHtml: string,
  baseUrl: string,
  options: {
    maxTeamPages?: number;
    maxPortfolioPages?: number;
    maxAboutPages?: number;
    includeNews?: boolean;
    includeOther?: boolean;
  } = {}
): DiscoveredURL[] {
  const {
    maxTeamPages = 5,
    maxPortfolioPages = 3,
    maxAboutPages = 2,
    includeNews = false,
    includeOther = false,
  } = options;

  // Extract all links
  const allLinks = extractAllLinks(homepageHtml, baseUrl);

  // Categorize and prioritize
  const discovered: DiscoveredURL[] = allLinks.map(({ url, text }) => {
    const category = categorizeURL(url, text);
    const priority = assignPriority(category);
    return { url, category, priority, text };
  });

  // Filter and limit by category
  const filtered: DiscoveredURL[] = [];

  // Team pages (highest priority)
  const teamPages = discovered.filter(d => d.category === 'team')
    .sort((a, b) => a.priority - b.priority)
    .slice(0, maxTeamPages);
  filtered.push(...teamPages);

  // Portfolio pages
  const portfolioPages = discovered.filter(d => d.category === 'portfolio')
    .sort((a, b) => a.priority - b.priority)
    .slice(0, maxPortfolioPages);
  filtered.push(...portfolioPages);

  // About pages
  const aboutPages = discovered.filter(d => d.category === 'about')
    .sort((a, b) => a.priority - b.priority)
    .slice(0, maxAboutPages);
  filtered.push(...aboutPages);

  // Optional: News pages
  if (includeNews) {
    const newsPages = discovered.filter(d => d.category === 'news')
      .slice(0, 2);
    filtered.push(...newsPages);
  }

  // Optional: Other pages
  if (includeOther) {
    const otherPages = discovered.filter(d => d.category === 'other')
      .slice(0, 3);
    filtered.push(...otherPages);
  }

  return filtered;
}

/**
 * Statistics for multi-URL discovery
 */
export interface DiscoveryStats {
  totalLinksFound: number;
  teamPagesFound: number;
  portfolioPagesFound: number;
  aboutPagesFound: number;
  newsPagesFound: number;
  otherPagesFound: number;
  selectedForScraping: number;
}

/**
 * Analyze discovered URLs and return statistics
 */
export function analyzeDiscoveredURLs(discovered: DiscoveredURL[]): DiscoveryStats {
  return {
    totalLinksFound: discovered.length,
    teamPagesFound: discovered.filter(d => d.category === 'team').length,
    portfolioPagesFound: discovered.filter(d => d.category === 'portfolio').length,
    aboutPagesFound: discovered.filter(d => d.category === 'about').length,
    newsPagesFound: discovered.filter(d => d.category === 'news').length,
    otherPagesFound: discovered.filter(d => d.category === 'other').length,
    selectedForScraping: discovered.length,
  };
}

/**
 * Log discovery statistics
 */
export function logDiscoveryStats(firmName: string, stats: DiscoveryStats) {
  console.log(`[Multi-URL Discovery] ${firmName}:`);
  console.log(`  Total links found: ${stats.totalLinksFound}`);
  console.log(`  Team pages: ${stats.teamPagesFound}`);
  console.log(`  Portfolio pages: ${stats.portfolioPagesFound}`);
  console.log(`  About pages: ${stats.aboutPagesFound}`);
  console.log(`  Selected for scraping: ${stats.selectedForScraping}`);
}

/**
 * Generate standard team/portfolio URL patterns to try
 * Used as fallback when no links are discovered
 */
export function generateStandardURLs(baseUrl: string): DiscoveredURL[] {
  const base = new URL(baseUrl);
  const origin = base.origin;
  
  const standardPatterns: Array<{ path: string; category: DiscoveredURL['category']; text: string }> = [
    // Team pages
    { path: '/team', category: 'team', text: 'Team' },
    { path: '/people', category: 'team', text: 'People' },
    { path: '/about-us', category: 'team', text: 'About Us' },
    { path: '/leadership', category: 'team', text: 'Leadership' },
    { path: '/our-team', category: 'team', text: 'Our Team' },
    { path: '/partners', category: 'team', text: 'Partners' },
    { path: '/management', category: 'team', text: 'Management' },
    { path: '/professionals', category: 'team', text: 'Professionals' },
    // Portfolio pages
    { path: '/portfolio', category: 'portfolio', text: 'Portfolio' },
    { path: '/companies', category: 'portfolio', text: 'Companies' },
    { path: '/investments', category: 'portfolio', text: 'Investments' },
    { path: '/our-portfolio', category: 'portfolio', text: 'Our Portfolio' },
    // About pages
    { path: '/about', category: 'about', text: 'About' },
    { path: '/about-us', category: 'about', text: 'About Us' },
  ];
  
  return standardPatterns.map(({ path, category, text }) => ({
    url: `${origin}${path}`,
    category,
    priority: assignPriority(category),
    text,
  }));
}
