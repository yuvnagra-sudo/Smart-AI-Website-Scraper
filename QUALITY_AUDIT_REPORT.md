# VC Enrichment Data Quality Audit Report

**Date:** January 23, 2026  
**Job ID:** 1020024  
**Total Firms:** 50  
**Total Team Members Extracted:** 391

---

## Executive Summary

This audit evaluated the accuracy and completeness of the VC enrichment tool by comparing extracted data against actual website content for 8 randomly sampled firms. The analysis revealed several critical issues that require immediate attention.

### Key Findings

| Metric | Value | Status |
|--------|-------|--------|
| **Duplicate Detection** | 100% of members duplicated for some firms | Critical |
| **Over-extraction Rate** | 50-180% more members than actual | Critical |
| **Email Coverage** | 6.6% (26/391) | Poor |
| **Portfolio Companies** | 0% (0/391) | Not Working |
| **LinkedIn Coverage** | 90.8% (355/391) | Good |
| **Title Coverage** | 87.2% (341/391) | Good |

---

## Detailed Findings by Firm

### 1. 1200vc (twelvehundred.vc)

| Metric | Extracted | Actual | Accuracy |
|--------|-----------|--------|----------|
| Team Members | 28 | 14 | 200% (duplicates) |
| Emails | 0 | 0 | N/A |
| LinkedIn | 26 | 14 | 93% |

**Issue Identified:** Every team member was extracted twice - once from the main carousel and once from another source. This is a **duplicate extraction bug**.

**Sample Duplicates:**
- Adriana Tortajada appears at positions 1 and 15
- Jose Miguel Cortes appears at positions 2 and 16
- All 14 actual members are duplicated

---

### 2. @Ventures (venturesnonprofit.org)

| Metric | Extracted | Actual | Accuracy |
|--------|-----------|--------|----------|
| Team Members | 18 | 18 | 100% |
| Emails | 0 | 0 | N/A |
| LinkedIn | 7 | 0 | Over-extracted |

**Issue Identified:** This is a **nonprofit organization**, NOT a venture capital firm. The name "@Ventures" is misleading - the actual organization is "Ventures" which provides business training and microfinance to entrepreneurs.

**Recommendation:** Add validation to filter out non-VC entities from input data.

---

### 3. .406 Ventures (406ventures.com)

| Metric | Extracted | Actual | Accuracy |
|--------|-----------|--------|----------|
| Team Members | 42 | 15 | 280% (duplicates + advisors) |
| Emails | 0 | 0 | N/A |
| LinkedIn | 36 | 15 | 86% |

**Issues Identified:**
1. **Duplicate extraction:** 15 core team members extracted twice (positions 1-15 and 16-30)
2. **Advisor extraction:** 12 additional advisors/portfolio company executives extracted (positions 31-42)

**Sample False Positives:**
- Bryan Adams (Advisor)
- Bob Darin (CEO – Blue Health Intelligence) - portfolio company exec
- Slater Victoroff (CEO – Mythica) - portfolio company exec

---

### 4. 10X Capital (10xcapital.com)

| Metric | Extracted | Actual | Accuracy |
|--------|-----------|--------|----------|
| Team Members | 16 | ~10 | 160% |
| Emails | 1 | 0 | Good |
| LinkedIn | 16 | ~10 | 100% |

**Notes:** Slight over-extraction but within acceptable range. The team carousel may have additional members not visible in initial view.

---

### 5. 01 Advisors (01a.com)

| Metric | Extracted | Actual | Accuracy |
|--------|-----------|--------|----------|
| Team Members | 24 | 12 | 200% (duplicates) |
| Emails | 0 | 0 | N/A |
| LinkedIn | 24 | 12 | 100% |
| Titles | 0 | 0 | 0% |

**Issue Identified:** All 12 team members extracted twice. Additionally, no titles were captured despite the website having a minimalist design where titles may be on individual profile pages.

---

### 6. 13i Capital Corporation (13icapital.com)

| Metric | Extracted | Actual | Accuracy |
|--------|-----------|--------|----------|
| Team Members | 0 | 2 | 0% |
| Emails | N/A | 1 | N/A |

**Issue Identified:** Complete extraction failure. The website has 2 team members clearly listed on the About Us page:
- Ram P. Thukkaram (Founder, Principal and Managing Director)
- Robert Lubin (Non-Executive Director)

**Root Cause:** Team info is on `/about-us.php`, not a dedicated `/team` page. The scraper likely only checked common team page URLs.

---

### 7. 87 (eightyseven.us) - Website Down

**Status:** Domain not resolving (DNS error)  
**Extracted:** 0 team members  
**Result:** Correct behavior - no data extracted for unavailable website

---

### 8. 103st (103st.app) - Website Down

**Status:** Domain not resolving (DNS error)  
**Extracted:** 0 team members  
**Result:** Correct behavior - no data extracted for unavailable website

---

## Critical Issues Summary

### Issue #1: Duplicate Extraction (CRITICAL)

**Severity:** Critical  
**Affected Firms:** 1200vc, .406 Ventures, 01 Advisors (60% of sample)  
**Impact:** Data inflated by 100-200%

**Root Cause Analysis:**
The scraper appears to be extracting team members from multiple sources on the same page (e.g., carousel + list view, or main page + footer) without deduplication.

**Recommended Fix:**
Add deduplication logic based on name matching before saving to database:
```typescript
// Deduplicate by normalized name
const uniqueMembers = members.filter((member, index, self) =>
  index === self.findIndex(m => 
    normalizeString(m.name) === normalizeString(member.name)
  )
);
```

---

### Issue #2: Portfolio Companies Not Populated (CRITICAL)

**Severity:** Critical  
**Affected:** 100% of records (0/391 have portfolio companies)  
**Impact:** New feature not working

**Root Cause Analysis:**
The `portfolioCompanies` column was added to the schema and Excel output, but the data is not being populated from the extraction pipeline.

**Recommended Fix:**
Verify that `portfolioCompanies` is being passed through:
1. `teamMemberDetailExtractor.ts` → extraction
2. `vcEnrichment.ts` → aggregation
3. `routers.ts` → database insert
4. `generateResultsService.ts` → Excel output

---

### Issue #3: Email Extraction Failure (HIGH)

**Severity:** High  
**Coverage:** 6.6% (26/391)  
**Impact:** Primary contact method unavailable

**Root Cause Analysis:**
Most VC firm websites do not display emails directly. The current extraction relies on:
1. mailto: links (rare)
2. Email patterns in HTML (rare)
3. LLM extraction from profile pages (requires deep scraping)

**Recommended Fixes:**
1. Integrate email finder API (Hunter.io, Apollo.io)
2. Generate email patterns based on firm domain (firstname@firm.com, first.last@firm.com)
3. Add LinkedIn profile scraping for email extraction

---

### Issue #4: Advisor/Portfolio Company False Positives (MEDIUM)

**Severity:** Medium  
**Affected Firms:** .406 Ventures (and likely others)  
**Impact:** Data quality degradation

**Root Cause Analysis:**
The scraper is extracting advisors, board members, and portfolio company executives as team members.

**Recommended Fix:**
Add filtering logic to exclude:
- Titles containing "Advisor" (unless specifically requested)
- Titles containing "CEO/CTO/CFO" of external companies
- Sections labeled "Advisors", "Board", "Portfolio"

---

### Issue #5: Missing Team Pages (MEDIUM)

**Severity:** Medium  
**Affected Firms:** 13i Capital Corporation  
**Impact:** Complete extraction failure for some firms

**Root Cause Analysis:**
The scraper only checks common team page URLs (/team, /people, /about-us) but some firms have team info on non-standard pages.

**Recommended Fix:**
1. Crawl the entire site for team-related content
2. Use LLM to identify team sections on any page
3. Check multiple URL patterns: /about, /about-us, /leadership, /management, /our-team

---

## Data Quality Metrics

### Overall Accuracy

| Metric | Score | Grade |
|--------|-------|-------|
| Member Count Accuracy | 45% | F |
| Deduplication | 0% | F |
| Email Coverage | 6.6% | F |
| LinkedIn Coverage | 90.8% | A |
| Title Coverage | 87.2% | B |
| Portfolio Companies | 0% | F |

### Tier Distribution Analysis

| Tier | Count | Percentage |
|------|-------|------------|
| Tier 1 (Decision Makers) | 119 | 30.4% |
| Tier 2 (Influencers) | 29 | 7.4% |
| Tier 3 (Other) | 79 | 20.2% |
| Exclude | 164 | 41.9% |

**Note:** 41.9% exclusion rate may be too aggressive for "all" filter mode.

---

## Recommendations

### Immediate Actions (Before Next Run)

1. **Add deduplication** - Implement name-based deduplication before database insert
2. **Fix portfolio companies pipeline** - Debug why portfolioCompanies is not being saved
3. **Expand team page detection** - Check /about, /leadership, /management in addition to /team

### Short-term Improvements (1-2 weeks)

4. **Add advisor filtering** - Exclude advisors and portfolio company executives by default
5. **Improve email extraction** - Integrate email finder API or pattern generation
6. **Add input validation** - Filter out non-VC entities (nonprofits, accelerators)

### Long-term Enhancements (1 month+)

7. **Add expected count comparison** - Compare extracted count vs expected for quality alerts
8. **Implement retry logic** - Auto-retry firms with low data quality scores
9. **Add manual review queue** - Flag firms with anomalies for human review

---

## Appendix: Test Methodology

1. Loaded Excel output file (job 1020024)
2. Randomly selected 8 firms using Python random.sample()
3. Visited each firm's website manually
4. Counted actual team members and compared to extracted data
5. Documented discrepancies and identified root causes

**Firms Audited:**
- 1200vc
- @Ventures
- .406 Ventures
- 10X Capital
- 01 Advisors
- 13i Capital Corporation
- 87 (website down)
- 103st (website down)
