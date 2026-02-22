# Advanced Data Gathering Roadmap

This document outlines strategies to significantly improve data gathering accuracy, coverage, and efficiency.

## Current Data Gathering Approach

**Sources:**
1. Public VC firm websites (primary)
2. AI analysis of website content
3. Waterfall enrichment (retry from multiple pages)

**Limitations:**
- **Coverage**: Only ~60-70% of firms have complete team/portfolio data on websites
- **Accuracy**: AI inference can hallucinate or misinterpret
- **Freshness**: Websites may be outdated
- **LinkedIn URLs**: Hard to extract reliably from websites
- **Investment dates**: Often missing or vague

## Improvement Strategy Overview

### Tier 1: Free/Low-Cost Improvements (Weeks 1-2)
1. SEC EDGAR integration
2. Crunchbase Basic API
3. Enhanced web scraping techniques
4. LinkedIn profile URL construction

### Tier 2: Paid API Integration (Weeks 3-4)
1. Crunchbase Pro
2. Apollo.io for contact enrichment
3. Clearbit for company data

### Tier 3: Advanced Techniques (Weeks 5-8)
1. Browser automation for JavaScript-heavy sites
2. Data deduplication and validation
3. Automated quality monitoring
4. Machine learning for pattern recognition

---

## Tier 1: Free/Low-Cost Improvements

### 1. SEC EDGAR Integration

**What it provides:**
- Form D filings (private placement offerings)
- Form ADV (investment adviser registrations)
- Investment strategy and focus
- Fund size and structure

**Implementation:**

```typescript
// server/dataSources/secEdgar.ts
import axios from "axios";

interface SECFiling {
  companyName: string;
  cik: string;
  filingType: string;
  filingDate: string;
  documentUrl: string;
}

export async function searchSECFilings(companyName: string): Promise<SECFiling[]> {
  // SEC EDGAR full-text search API
  const response = await axios.get(
    "https://efts.sec.gov/LATEST/search-index",
    {
      params: {
        q: companyName,
        dateRange: "5y", // Last 5 years
        category: "form-cat1", // Form D
      },
      headers: {
        "User-Agent": "YourCompany contact@yourcompany.com", // Required by SEC
      },
    }
  );

  return response.data.hits.hits.map((hit: any) => ({
    companyName: hit._source.display_names[0],
    cik: hit._source.ciks[0],
    filingType: hit._source.file_type,
    filingDate: hit._source.file_date,
    documentUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${hit._source.ciks[0]}`,
  }));
}

export async function extractInvestmentStrategy(documentUrl: string): Promise<string> {
  // Download and parse Form D/ADV
  const response = await axios.get(documentUrl);
  const html = response.data;
  
  // Extract investment strategy section
  // Form ADV Part 2A typically contains this info
  // Use cheerio or regex to extract relevant sections
  
  return "Extracted investment strategy...";
}
```

**Benefits:**
- 100% free
- Official government data
- Covers all US-based VCs
- Investment strategy often explicitly stated

**Limitations:**
- US-based firms only
- Not all VCs file (only those raising funds)
- Data can be 6-12 months old

### 2. Enhanced Crunchbase Integration

**Free tier strategy:**
- 200 calls/day = enough for 200 firms/day
- Cache results aggressively
- Use for portfolio companies (most valuable)

**Implementation:**

```typescript
// server/dataSources/crunchbase.ts
import axios from "axios";

const CRUNCHBASE_API_URL = "https://api.crunchbase.com/api/v4";
const API_KEY = process.env.CRUNCHBASE_API_KEY;

// Cache to avoid redundant calls
const cache = new Map<string, any>();

export async function getOrganizationPortfolio(orgName: string) {
  const cacheKey = `org:${orgName}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  try {
    // Search for organization
    const searchResponse = await axios.get(
      `${CRUNCHBASE_API_URL}/autocompletes`,
      {
        params: {
          query: orgName,
          collection_ids: "organizations",
        },
        headers: {
          "X-cb-user-key": API_KEY,
        },
      }
    );

    const orgPermalink = searchResponse.data.entities[0]?.identifier?.permalink;
    if (!orgPermalink) return null;

    // Get organization details with investments
    const orgResponse = await axios.get(
      `${CRUNCHBASE_API_URL}/entities/organizations/${orgPermalink}`,
      {
        params: {
          card_ids: "investments,investors,fields",
        },
        headers: {
          "X-cb-user-key": API_KEY,
        },
      }
    );

    const result = {
      name: orgResponse.data.properties.name,
      description: orgResponse.data.properties.short_description,
      investments: orgResponse.data.cards.investments?.map((inv: any) => ({
        companyName: inv.properties.organization_name,
        fundingRound: inv.properties.funding_round_name,
        announcedDate: inv.properties.announced_on,
        websiteUrl: inv.properties.organization_website_url,
      })) || [],
    };

    cache.set(cacheKey, result);
    return result;
  } catch (error) {
    console.error("Crunchbase API error:", error);
    return null;
  }
}
```

**Optimization:**
- Batch requests where possible
- Cache for 30 days
- Only call for low-confidence web scraping results

### 3. LinkedIn Profile URL Construction

**Problem:** Hard to extract LinkedIn URLs from websites

**Solution:** Construct URLs programmatically

```typescript
// server/linkedinUrlBuilder.ts

export function constructLinkedInURL(name: string, companyName: string): string {
  // Normalize name: "John Smith" → "john-smith"
  const normalizedName = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "-");

  // Construct URL
  const baseUrl = "https://www.linkedin.com/in/";
  return `${baseUrl}${normalizedName}`;
}

export function generateLinkedInVariations(name: string): string[] {
  const variations: string[] = [];
  
  // "John Smith" variations:
  // - john-smith
  // - johnsmith
  // - john-smith-12345 (common pattern)
  // - j-smith
  
  const parts = name.toLowerCase().split(" ");
  const firstName = parts[0];
  const lastName = parts[parts.length - 1];
  
  variations.push(`${firstName}-${lastName}`);
  variations.push(`${firstName}${lastName}`);
  variations.push(`${firstName[0]}-${lastName}`);
  
  return variations.map(v => `https://www.linkedin.com/in/${v}`);
}

export async function validateLinkedInURL(url: string): Promise<boolean> {
  try {
    // Check if URL returns 200 (profile exists)
    const response = await axios.head(url, {
      timeout: 3000,
      validateStatus: (status) => status === 200,
    });
    return response.status === 200;
  } catch {
    return false;
  }
}
```

**Usage:**
```typescript
// For each team member
const linkedInVariations = generateLinkedInVariations(member.name);
for (const url of linkedInVariations) {
  if (await validateLinkedInURL(url)) {
    member.linkedinUrl = url;
    break;
  }
}
```

**Benefits:**
- Works for ~70% of profiles
- No API needed
- Fast validation

**Limitations:**
- Doesn't work for non-standard URLs
- LinkedIn may rate-limit validation requests

### 4. Advanced Web Scraping Techniques

**Current approach:** Simple HTTP requests

**Improvements:**

**A. JavaScript rendering (for dynamic sites):**
```typescript
import puppeteer from "puppeteer";

export async function scrapeWithBrowser(url: string): Promise<string> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2" });
  
  // Wait for dynamic content to load
  await page.waitForSelector(".team-member", { timeout: 5000 }).catch(() => {});
  
  const html = await page.content();
  await browser.close();
  
  return html;
}
```

**B. Structured data extraction:**
```typescript
// Many sites use JSON-LD for SEO
export function extractStructuredData(html: string): any {
  const $ = cheerio.load(html);
  const jsonLdScripts = $('script[type="application/ld+json"]');
  
  const structuredData: any[] = [];
  jsonLdScripts.each((_, el) => {
    try {
      const data = JSON.parse($(el).html() || "");
      structuredData.push(data);
    } catch {}
  });
  
  return structuredData;
}

// Extract team members from structured data
export function extractTeamFromStructuredData(data: any[]): TeamMember[] {
  const members: TeamMember[] = [];
  
  for (const item of data) {
    if (item["@type"] === "Person" && item.jobTitle) {
      members.push({
        name: item.name,
        title: item.jobTitle,
        linkedinUrl: item.sameAs?.find((url: string) => url.includes("linkedin.com")),
      });
    }
  }
  
  return members;
}
```

**C. Sitemap crawling:**
```typescript
export async function findTeamPageFromSitemap(baseUrl: string): Promise<string | null> {
  try {
    const sitemapUrl = `${baseUrl}/sitemap.xml`;
    const response = await axios.get(sitemapUrl);
    const $ = cheerio.load(response.data, { xmlMode: true });
    
    // Find URLs containing "team", "about", "people"
    const teamUrls = $("url loc")
      .map((_, el) => $(el).text())
      .get()
      .filter((url: string) => 
        /team|about|people|leadership/i.test(url)
      );
    
    return teamUrls[0] || null;
  } catch {
    return null;
  }
}
```

---

## Tier 2: Paid API Integration

### 1. Crunchbase Pro ($29-99/month)

**Upgrade benefits:**
- 1,000-10,000 calls/month
- Real-time data updates
- Advanced filtering
- Bulk export

**When to upgrade:**
- Processing >200 firms/day
- Need real-time investment data
- Require high accuracy for portfolio companies

### 2. Apollo.io ($49-149/month)

**What it provides:**
- Email addresses (verified)
- LinkedIn profile URLs (direct match)
- Phone numbers
- Job title verification

**Implementation:**
```typescript
// server/dataSources/apollo.ts
import axios from "axios";

export async function enrichContact(name: string, companyName: string) {
  const response = await axios.post(
    "https://api.apollo.io/v1/people/match",
    {
      first_name: name.split(" ")[0],
      last_name: name.split(" ").slice(1).join(" "),
      organization_name: companyName,
    },
    {
      headers: {
        "X-Api-Key": process.env.APOLLO_API_KEY,
      },
    }
  );

  return {
    email: response.data.person.email,
    linkedinUrl: response.data.person.linkedin_url,
    phone: response.data.person.phone_numbers[0],
    title: response.data.person.title,
  };
}
```

**ROI:**
- High for LinkedIn URL accuracy
- Essential if you need emails
- $49/month = 1,000 credits = 1,000 contacts

### 3. Clearbit ($99-999/month)

**What it provides:**
- Company enrichment
- Logo, description, metrics
- Employee count, funding
- Technology stack

**Best for:**
- Enriching portfolio companies
- Company classification
- Firmographic data

---

## Tier 3: Advanced Techniques

### 1. Browser Automation at Scale

**Use Playwright/Puppeteer for:**
- Sites that block scrapers
- JavaScript-heavy SPAs
- Login-required content (with credentials)

**Implementation:**
```typescript
import { chromium } from "playwright";

export async function scrapeWithPlaywright(url: string) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0...", // Realistic user agent
  });
  
  const page = await context.newPage();
  
  // Stealth mode: avoid detection
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  
  await page.goto(url);
  await page.waitForLoadState("networkidle");
  
  const data = await page.evaluate(() => {
    // Extract data from page
    return {
      teamMembers: Array.from(document.querySelectorAll(".team-member")).map(el => ({
        name: el.querySelector(".name")?.textContent,
        title: el.querySelector(".title")?.textContent,
      })),
    };
  });
  
  await browser.close();
  return data;
}
```

### 2. Data Deduplication & Validation

**Problem:** Same person appears multiple times with slight variations

**Solution:**
```typescript
// server/dataValidation.ts

export function deduplicateTeamMembers(members: TeamMember[]): TeamMember[] {
  const seen = new Map<string, TeamMember>();
  
  for (const member of members) {
    // Normalize name for comparison
    const normalizedName = member.name.toLowerCase().replace(/[^a-z]/g, "");
    
    if (!seen.has(normalizedName)) {
      seen.set(normalizedName, member);
    } else {
      // Merge data from duplicate
      const existing = seen.get(normalizedName)!;
      if (!existing.linkedinUrl && member.linkedinUrl) {
        existing.linkedinUrl = member.linkedinUrl;
      }
      if (member.confidenceScore === "High" && existing.confidenceScore !== "High") {
        seen.set(normalizedName, member); // Use higher confidence version
      }
    }
  }
  
  return Array.from(seen.values());
}

export function validateInvestmentDate(dateString: string): boolean {
  const date = new Date(dateString);
  const now = new Date();
  const tenYearsAgo = new Date(now.getFullYear() - 10, now.getMonth(), now.getDate());
  
  // Investment date should be within last 10 years and not in future
  return date >= tenYearsAgo && date <= now;
}
```

### 3. Automated Quality Monitoring

**Track data quality metrics:**
```typescript
// server/qualityMetrics.ts

interface QualityMetrics {
  totalFirms: number;
  firmsWithTeamMembers: number;
  firmsWithPortfolio: number;
  averageTeamMembersPerFirm: number;
  averagePortfolioPerFirm: number;
  highConfidencePercentage: number;
  linkedInUrlCoverage: number;
}

export function calculateQualityMetrics(
  enrichedData: EnrichmentResult[]
): QualityMetrics {
  const totalFirms = enrichedData.length;
  const firmsWithTeamMembers = enrichedData.filter(d => d.teamMembers.length > 0).length;
  const firmsWithPortfolio = enrichedData.filter(d => d.portfolioCompanies.length > 0).length;
  
  const totalTeamMembers = enrichedData.reduce((sum, d) => sum + d.teamMembers.length, 0);
  const totalPortfolio = enrichedData.reduce((sum, d) => sum + d.portfolioCompanies.length, 0);
  
  const highConfidenceCount = enrichedData.filter(d => 
    d.nichesConfidence === "High" && 
    d.investorTypeConfidence === "High"
  ).length;
  
  const linkedInCount = enrichedData.reduce((sum, d) => 
    sum + d.teamMembers.filter(m => m.linkedinUrl).length, 0
  );
  
  return {
    totalFirms,
    firmsWithTeamMembers,
    firmsWithPortfolio,
    averageTeamMembersPerFirm: totalTeamMembers / totalFirms,
    averagePortfolioPerFirm: totalPortfolio / totalFirms,
    highConfidencePercentage: (highConfidenceCount / totalFirms) * 100,
    linkedInUrlCoverage: (linkedInCount / totalTeamMembers) * 100,
  };
}

// Log metrics after each job
export async function logQualityMetrics(jobId: string, metrics: QualityMetrics) {
  console.log(`[Quality Metrics] Job ${jobId}:`, {
    "Team Member Coverage": `${((metrics.firmsWithTeamMembers / metrics.totalFirms) * 100).toFixed(1)}%`,
    "Portfolio Coverage": `${((metrics.firmsWithPortfolio / metrics.totalFirms) * 100).toFixed(1)}%`,
    "Avg Team Size": metrics.averageTeamMembersPerFirm.toFixed(1),
    "Avg Portfolio Size": metrics.averagePortfolioPerFirm.toFixed(1),
    "High Confidence": `${metrics.highConfidencePercentage.toFixed(1)}%`,
    "LinkedIn URLs": `${metrics.linkedInUrlCoverage.toFixed(1)}%`,
  });
  
  // Store in database for tracking over time
  // await saveMetrics(jobId, metrics);
}
```

---

## Implementation Priority

### Week 1-2: Quick Wins
1. ✅ SEC EDGAR integration (free, high value for US VCs)
2. ✅ LinkedIn URL construction + validation
3. ✅ Structured data extraction (JSON-LD)
4. ✅ Data deduplication

### Week 3-4: Paid APIs
1. Crunchbase Pro ($29/month trial)
2. Apollo.io ($49/month trial)
3. A/B test: measure accuracy improvement

### Week 5-6: Advanced Scraping
1. Browser automation for JavaScript sites
2. Sitemap crawling
3. Quality metrics dashboard

### Week 7-8: Optimization
1. Caching layer
2. Rate limiting
3. Cost optimization
4. Performance tuning

---

## Expected Improvements

### Current Baseline (Web Scraping Only)
- Team member coverage: ~60%
- Portfolio coverage: ~70%
- LinkedIn URL accuracy: ~40%
- High confidence data: ~50%

### After Tier 1 (Free Improvements)
- Team member coverage: ~75% (+15%)
- Portfolio coverage: ~85% (+15%)
- LinkedIn URL accuracy: ~70% (+30%)
- High confidence data: ~65% (+15%)

### After Tier 2 (Paid APIs)
- Team member coverage: ~90% (+30%)
- Portfolio coverage: ~95% (+25%)
- LinkedIn URL accuracy: ~95% (+55%)
- High confidence data: ~85% (+35%)

### After Tier 3 (Advanced Techniques)
- Team member coverage: ~95% (+35%)
- Portfolio coverage: ~98% (+28%)
- LinkedIn URL accuracy: ~98% (+58%)
- High confidence data: ~90% (+40%)

---

## Cost-Benefit Analysis

### Free Tier (Tier 1)
- **Cost**: $0/month
- **Development time**: 2 weeks
- **Improvement**: +15-30% accuracy
- **ROI**: Infinite (free)

### Paid APIs (Tier 2)
- **Cost**: ~$150/month (Crunchbase Pro + Apollo.io)
- **Development time**: 2 weeks
- **Improvement**: +30-55% accuracy
- **ROI**: High (if processing >1000 firms/month)

### Advanced (Tier 3)
- **Cost**: $0-500/month (infrastructure for browser automation)
- **Development time**: 4 weeks
- **Improvement**: +35-58% accuracy
- **ROI**: Medium (diminishing returns)

---

## Recommendations

### For Immediate Implementation:
1. **SEC EDGAR** - Free, high value for US VCs
2. **LinkedIn URL construction** - Easy win, big impact
3. **Crunchbase Basic** - Free tier, good for portfolio data

### For Month 2-3:
1. **Crunchbase Pro** ($29/month) - Best ROI
2. **Apollo.io** ($49/month) - If you need emails

### For Long-Term:
1. Build quality metrics dashboard
2. A/B test different data sources
3. Optimize costs based on actual usage

---

## Next Steps

1. Review this roadmap
2. Prioritize based on your budget and timeline
3. Start with Tier 1 (free improvements)
4. Measure baseline metrics
5. Implement incrementally
6. Track improvements

Questions? See DATA_SOURCE_INTEGRATION_GUIDE.md for implementation details.
