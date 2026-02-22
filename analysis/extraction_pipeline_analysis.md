# Extraction Pipeline Analysis

## Current Data Flow

### 1. Recursive Scraper Flow
```
Homepage → LLMPageAnalyzer → Extract data + Suggest URLs
    ↓
For each suggested URL:
    Fetch → LLMPageAnalyzer → Extract more data + Suggest more URLs
    ↓
Repeat until max depth/pages
    ↓
Deduplicate all collected data
    ↓
Return: teamMembers, portfolioCompanies, firmDescription
```

### 2. Where Investment Mandate Should Come From

The `firmDescription` field in `LLMPageAnalyzer` is supposed to capture this, but:

**Current Prompt Issues:**
1. The prompt says "firm_description" but doesn't explicitly ask for:
   - Investment thesis/mandate
   - AUM (assets under management)
   - Investment stages
   - Sector focus areas
   
2. The prompt focuses heavily on team extraction, not firm-level data

3. The `firmDescription` field is just a single string - no structured data for:
   - `aum`
   - `investment_thesis`
   - `sector_focus`
   - `geographic_focus`

### 3. Where Investment Type/Stages/Niches Come From

These are extracted SEPARATELY in `vcEnrichment.ts`:
- `extractInvestorType()` - Line 599
- `extractInvestmentStages()` - Line 665
- `extractInvestmentNiches()` - Line 534

**Problem:** These functions only fetch the HOMEPAGE and extract from there.
They don't use the data from the recursive scraper's exploration of /about pages!

### 4. Email Extraction Issues

**Current Flow:**
1. `LLMPageAnalyzer` extracts emails during page analysis
2. `teamMemberDetailExtractor.ts` extracts emails from profile pages
3. `extractEmailsFromHTML()` in vcEnrichment.ts extracts from main page

**Problems Identified:**
1. LLM may not reliably extract emails from HTML (needs explicit patterns)
2. Many VC sites don't show emails publicly
3. Email extraction from main page happens AFTER team extraction - may not link properly
4. No email finder API integration (Hunter.io, Apollo.io)

## Recommended Fixes

### Fix 1: Enhance LLMPageAnalyzer Prompt for Firm Data

Add explicit fields:
- `investment_thesis` - The firm's stated investment philosophy
- `aum` - Assets under management (extract dollar amounts)
- `investment_stages` - Seed, Series A, Growth, etc.
- `sector_focus` - Detailed list of sectors
- `geographic_focus` - Geographic preferences

### Fix 2: Use Recursive Scraper Data for Firm Analysis

Instead of only using homepage for investor type/stages/niches:
- Use ALL content collected by recursive scraper
- Especially content from /about pages
- Pass firmDescription from recursive scraper to analysis functions

### Fix 3: Improve Email Extraction

1. Add explicit email pattern extraction BEFORE LLM analysis
2. Look for mailto: links in raw HTML
3. Look for common email patterns: firstname@domain.com, first.last@domain.com
4. Consider adding email finder API as fallback

### Fix 4: Add Investment Mandate to Output

Currently the Excel output doesn't have columns for:
- Investment thesis
- AUM
- Detailed sector focus

Need to add these to:
- Database schema
- Excel output
- UI display
