# Data Source Integration Guide

This guide explains how to integrate professional data sources to enhance enrichment accuracy, similar to how Pitchbook, Apollo, and Crunchbase operate.

## Current Implementation

The application currently uses:
- **Web scraping** from public VC firm websites
- **AI analysis** via Manus LLM API (gpt-4o-mini)
- **Waterfall enrichment** to retry low-confidence data from multiple pages

## Recommended Free/Low-Cost Data Sources

### 1. Crunchbase Basic API (Free Tier)
**What it provides:**
- Company funding rounds and investment history
- Investor profiles and portfolio companies
- Team member information

**Integration steps:**
1. Sign up at https://data.crunchbase.com/docs
2. Get API key (free tier: 200 calls/day)
3. Add to `.env`: `CRUNCHBASE_API_KEY=your_key`
4. Use endpoints:
   - `/organizations/{permalink}` - Company details
   - `/people/{permalink}` - Team member details
   - `/funding_rounds` - Investment history

**Cost:** Free (200 calls/day) or $29/month (1000 calls/day)

### 2. LinkedIn Sales Navigator (Requires Account)
**What it provides:**
- Team member LinkedIn profiles
- Job titles and employment history
- Direct LinkedIn URLs

**Integration approach:**
- Use LinkedIn's official API (requires partnership)
- OR use web scraping with rate limiting (gray area)
- OR manual export from Sales Navigator

**Cost:** $79.99/month for Sales Navigator

### 3. SEC EDGAR (Completely Free)
**What it provides:**
- US-based VC fund filings (Form D, Form ADV)
- Investment disclosures
- Fund size and strategy

**Integration steps:**
1. Use SEC EDGAR API: https://www.sec.gov/edgar/sec-api-documentation
2. No API key required
3. Search for Form D filings by company name
4. Extract investment strategy and fund details

**Cost:** Free

### 4. AngelList/Wellfound API
**What it provides:**
- Startup investments
- Investor profiles
- Portfolio companies

**Integration steps:**
1. Apply for API access at https://angel.co/api
2. Limited public data available
3. Focus on startup-side data

**Cost:** Free for basic access

## Recommended Paid Data Sources

### 1. Crunchbase Pro API
**What it provides:**
- Comprehensive investment data
- Real-time updates
- Advanced search and filtering

**Cost:** $29/month (1K calls) to $99/month (10K calls)

**ROI:** High - significantly improves portfolio company accuracy

### 2. PitchBook API
**What it provides:**
- Industry-standard VC data
- Detailed investment rounds
- Team member information
- Investment thesis and strategy

**Cost:** Enterprise pricing (typically $20K-$50K/year)

**ROI:** Very High - professional-grade data, but expensive

### 3. Apollo.io API
**What it provides:**
- Contact enrichment (emails, phone numbers)
- LinkedIn profile matching
- Company data

**Cost:** $49/month (1K credits) to $149/month (12K credits)

**ROI:** High for contact enrichment, especially LinkedIn URLs

### 4. ZoomInfo API
**What it provides:**
- B2B contact database
- Team member details
- Direct dial phone numbers

**Cost:** Enterprise pricing (typically $15K-$40K/year)

**ROI:** High for sales outreach, includes verified contact info

## Implementation Priority

### Phase 1: Free Sources (Immediate)
1. **SEC EDGAR** - Implement first, completely free
2. **Crunchbase Basic** - 200 free calls/day is enough for testing
3. **Manual LinkedIn** - Export from Sales Navigator if you have access

### Phase 2: Low-Cost Paid (Month 2-3)
1. **Crunchbase Pro** ($29-99/month) - Best ROI for portfolio data
2. **Apollo.io** ($49-149/month) - Excellent for LinkedIn URL matching

### Phase 3: Enterprise (When Scaling)
1. **PitchBook** - When processing 1000+ firms/month
2. **ZoomInfo** - When you need verified phone numbers

## How to Integrate a New Data Source

### Example: Adding Crunchbase API

1. **Install HTTP client** (already included: axios)

2. **Create data source module:**
```typescript
// server/dataSources/crunchbase.ts
import axios from "axios";

const CRUNCHBASE_API_URL = "https://api.crunchbase.com/api/v4";
const API_KEY = process.env.CRUNCHBASE_API_KEY;

export async function getOrganization(permalink: string) {
  const response = await axios.get(
    `${CRUNCHBASE_API_URL}/entities/organizations/${permalink}`,
    {
      headers: {
        "X-cb-user-key": API_KEY,
      },
      params: {
        card_ids: "fields,funding_rounds,investors",
      },
    }
  );
  return response.data;
}
```

3. **Update enrichment service:**
```typescript
// In server/vcEnrichment.ts
import { getOrganization } from "./dataSources/crunchbase";

// Add to extractPortfolioCompanies method:
try {
  const cbData = await getOrganization(companyPermalink);
  // Use cbData to enrich portfolio companies
} catch (error) {
  // Fall back to web scraping
}
```

4. **Add to waterfall enrichment:**
```typescript
// In server/waterfallEnrichment.ts
const sources = [
  { name: "Crunchbase API", fn: () => getCrunchbaseData() },
  { name: "About Page", url: aboutUrl },
  { name: "Portfolio Page", url: portfolioUrl },
];
```

## Data Quality Best Practices

### 1. Multi-Source Verification
Always cross-reference data from multiple sources:
- If Crunchbase says "Series A" but website says "Seed", flag as medium confidence
- If LinkedIn profile doesn't match website team page, verify manually

### 2. Confidence Scoring
Assign confidence based on source:
- **High:** Crunchbase Pro, PitchBook, SEC filings
- **Medium:** Crunchbase Basic, website scraping
- **Low:** AI inference, incomplete data

### 3. Rate Limiting
Respect API rate limits:
```typescript
import pLimit from "p-limit";

const limit = pLimit(5); // Max 5 concurrent requests
const results = await Promise.all(
  firms.map(firm => limit(() => enrichFirm(firm)))
);
```

### 4. Caching
Cache API responses to reduce costs:
```typescript
// Simple in-memory cache
const cache = new Map();

async function getCachedData(key: string, fetcher: () => Promise<any>) {
  if (cache.has(key)) {
    return cache.get(key);
  }
  const data = await fetcher();
  cache.set(key, data);
  return data;
}
```

## Cost Optimization Strategies

### 1. Batch Processing
Group API calls to minimize requests:
- Crunchbase allows bulk queries
- Cache common portfolio companies

### 2. Selective Enrichment
Only use paid APIs for:
- Low-confidence web scraping results
- High-priority firms (Tier 1 VCs)
- Recent portfolio companies (last 6 months)

### 3. Fallback Hierarchy
```
1. Check cache
2. Try free API (Crunchbase Basic, SEC EDGAR)
3. Web scraping
4. Paid API (only if confidence < 70%)
5. AI inference as last resort
```

## Compliance & Legal

### Important Considerations:
1. **LinkedIn Terms of Service** - Scraping is prohibited, use official API
2. **GDPR/Privacy** - Don't store personal data without consent
3. **API Terms** - Respect rate limits and usage restrictions
4. **Data Retention** - Delete cached data after 30-90 days

## Next Steps

1. Start with **SEC EDGAR** (free, no API key)
2. Add **Crunchbase Basic** (200 free calls/day)
3. Monitor accuracy improvements
4. Upgrade to paid tiers when processing volume justifies cost

## Questions?

For implementation help, refer to:
- `server/vcEnrichment.ts` - Main enrichment logic
- `server/waterfallEnrichment.ts` - Multi-source fallback
- `server/costEstimation.ts` - Cost calculation
