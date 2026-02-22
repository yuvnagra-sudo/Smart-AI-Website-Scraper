# Troubleshooting Summary - Dec 5, 2024

## Critical Issues Fixed

### 1. Andreessen Horowitz (a16z) Returning 0 Team Members ✅ FIXED

**Problem:**
- a16z.com/team consistently returned 0 team members despite having 100+ partners

**Root Cause:**
- a16z uses heavy JavaScript rendering (React-based SPA)
- Static HTML scraper fetched 8.9MB of HTML but only 106 chars of actual text content
- Scraper's JS-detection threshold was too low (50 chars)
- Scraper incorrectly marked the page as "success" and returned JS-unrendered HTML
- Team extraction received HTML with no rendered content → 0 members extracted

**Fix:**
1. **Raised JS-detection threshold** in `server/scraper/ComprehensiveScraper.ts`:
   - Team/people/about pages: 50 chars → **1000 chars**
   - Other pages: 50 chars → **200 chars**
2. **Installed Chrome/Puppeteer dependencies** in sandbox:
   - `npx puppeteer browsers install chrome`
   - System packages: libnss3, libatk1.0-0, libcups2, etc.
3. **Added logging** to track scraper strategy selection

**Result:**
- ✅ a16z now returns **90 Tier 1 members** (was 0)
- ✅ Total **556 team members** extracted
- ✅ Browser fallback working correctly
- ✅ Department-based classification working ("Investing" → Tier 1)

**Test Output:**
```
✓ Successfully scraped 521,880 characters (was 8,914,170)
Strategy used: headless_browser (was static_html)
Extracted text length: 16,446 chars (was 106)
Tier Distribution:
  Tier 1: 90 members
  Tier 3: 16 members
  Exclude: 450 members
```

---

### 2. Comprehensive Logging Added ✅ COMPLETE

**Changes:**
1. **vcEnrichment.ts** - Added logging for:
   - Firm name and URLs being processed
   - HTML fetch results (length, success/failure)
   - Raw team members extracted by LLM
   - LinkedIn URL matching results
   - Final enriched members with tier classification

2. **comprehensiveTeamExtraction.ts** - Added logging for:
   - HTML and text content lengths
   - Single-pass vs chunked processing
   - LLM extraction results per chunk
   - Sample titles extracted

3. **extractTeamMembersFromText** - Added logging for:
   - Text chunk size being processed
   - Number of members returned by LLM
   - Sample titles from extraction

**Benefits:**
- Easy to debug which firms fail and why
- Can see exactly what titles are being extracted
- Can verify tier classification is working correctly
- Can track scraper strategy selection

---

## Remaining Issues

### 1. Sequoia Capital - LIKELY FIXED (Needs Testing)

**Status:** Should be fixed by the same scraper improvements that fixed a16z

**Reasoning:**
- Sequoia likely uses similar JavaScript rendering
- Higher JS-detection threshold should trigger browser fallback
- Department-based classification already supports "Seed/Early", "Growth", "Investing"

**Next Step:** Test with real upload to verify

---

### 2. Three Firms Consistently Dropped (Conscience VC, Bessemer, Y Combinator)

**Status:** Needs investigation with actual uploaded file

**Possible Causes:**
1. Excel column name mismatch (case-sensitive?)
2. Empty required fields (name, website, description)
3. Invalid URL format
4. Encoding issues

**Next Step:** 
- User uploads test file
- Check server logs for Excel parsing debug output
- Logs will show which firms are skipped and why

---

### 3. Deep Profile Crawler Not Integrated

**Status:** Code exists but not wired into enrichment pipeline

**What Exists:**
- `server/scraper/DeepProfileCrawler.ts` - Fully implemented
- Can extract LinkedIn URLs, emails, portfolio investments from individual profile pages
- Rate limiting and error handling in place

**What's Missing:**
- Integration into `vcEnrichment.ts` team extraction flow
- Feature flag to enable/disable (performance impact)
- Testing with real VC firm profiles

**Impact:** 
- Currently only extracting data from main team page
- Missing LinkedIn URLs that are only on individual profile pages
- Missing detailed portfolio information per team member

---

### 4. Real-Time Progress Tracking Not Connected

**Status:** Backend complete, frontend not implemented

**What Exists:**
- `server/services/progressTracker.ts` - WebSocket-based progress tracking
- Backend emits progress events during enrichment

**What's Missing:**
- WebSocket client integration in `Dashboard.tsx`
- Progress bar component showing current firm and ETA
- Real-time updates every 3 seconds

**Impact:**
- Users can't see live progress during enrichment
- Dashboard only shows status after polling (every 3 seconds)
- No visibility into which firm is currently being processed

---

### 5. Performance Still Slow

**Status:** Needs profiling and optimization

**Current Performance:**
- 10 firms taking hours instead of 1-2 minutes
- Sequential processing (one firm at a time)
- Deep profile crawler adds 15-30s per firm if enabled

**Optimization Opportunities:**
1. **Parallel Processing:**
   - Process 3-5 firms concurrently
   - Use Promise.all() with batching
   - Respect rate limits per domain

2. **Timeout/Skip Logic:**
   - Skip firms that take > 60 seconds
   - Mark as "partial" instead of "failed"
   - Continue with remaining firms

3. **Caching:**
   - Cache team page HTML for 7 days (currently 30)
   - Cache LLM extraction results
   - Reuse browser instances

4. **Profile Actual Bottlenecks:**
   - Add timing logs for each step
   - Identify slowest operations
   - Optimize or parallelize

---

## Testing Plan

### Phase 1: Verify a16z/Sequoia Fix ✅ COMPLETE
- [x] Test a16z.com/team scraping manually
- [x] Verify 90+ Tier 1 members extracted
- [x] Verify browser fallback working

### Phase 2: Test with Real Upload
- [ ] User uploads 10-firm test file
- [ ] Monitor server logs for:
  - Which firms are processed
  - Which firms are dropped (if any)
  - Team member extraction counts
  - Tier classification results
- [ ] Verify Sequoia returns team members
- [ ] Identify why 3 firms are dropped

### Phase 3: Integration
- [ ] Integrate deep profile crawler (optional, feature flag)
- [ ] Add WebSocket client to Dashboard
- [ ] Implement parallel processing (3-5 firms)

### Phase 4: Performance Optimization
- [ ] Profile actual bottlenecks
- [ ] Implement timeout/skip logic
- [ ] Test with 100-firm upload
- [ ] Measure time per firm (target: <10 seconds)

---

## Files Changed

### Core Fixes
- `server/scraper/ComprehensiveScraper.ts` - Fixed JS-detection threshold
- `server/vcEnrichment.ts` - Added comprehensive logging
- `server/comprehensiveTeamExtraction.ts` - Added logging
- `todo.md` - Updated with completed tasks

### Test Files Created
- `test-a16z.ts` - Manual test script for a16z scraping
- `TROUBLESHOOTING_SUMMARY.md` - This document

---

## Next Steps

1. **Save checkpoint** with current fixes
2. **User tests** with 10-firm upload
3. **Analyze logs** to identify remaining issues
4. **Integrate** deep profile crawler (optional)
5. **Add** real-time progress tracking UI
6. **Optimize** performance (parallel processing)

---

## Key Learnings

1. **Always test with actual websites** - Don't assume static HTML is enough
2. **JS-rendered sites are common** - Many modern VC sites use React/Vue/Next.js
3. **Threshold matters** - Too low = false positives, too high = slow fallback
4. **Logging is essential** - Can't debug without visibility into what's happening
5. **Browser fallback is expensive** - Use sparingly, cache aggressively
