# Deep Profile Crawling Architecture

## Goal
Extract additional data from individual team member profile pages:
- LinkedIn URLs
- Email addresses
- Portfolio investments (company names, stages, co-investors)

## Current Flow
```
1. Scrape team page (e.g., sequoiacap.com/our-team)
2. Extract team members (names + departments)
3. Try to match LinkedIn URLs (smart URL constructor)
4. Return team members
```

## Enhanced Flow with Deep Crawling
```
1. Scrape team page
2. Extract team members with profile links
3. FOR EACH team member:
   a. Check if profile link exists
   b. Navigate to profile page
   c. Extract LinkedIn URL (if present)
   d. Extract email (if present)
   e. Extract portfolio investments (if present)
   f. Merge data with team member
4. Fallback to smart URL constructor for missing LinkedIn
5. Return enriched team members
```

## Implementation Strategy

### Phase 1: Profile Link Detection
- Parse team page HTML for profile links
- Common patterns:
  - `<a href="/people/konstantine-buhler">Konstantine Buhler</a>`
  - `<a href="/team/roelof-botha">Roelof Botha</a>`
  - `<div class="team-member" data-profile-url="...">`

### Phase 2: Profile Page Extraction
- Navigate to profile URL
- Extract structured data:
  - LinkedIn: Look for `linkedin.com/in/` links
  - Email: Look for `mailto:` links or email patterns
  - Portfolio: Look for tables/lists of investments

### Phase 3: Performance Optimization
- **Parallel processing**: Crawl 3-5 profiles concurrently
- **Caching**: Cache profile pages for 30 days
- **Rate limiting**: 2 requests/second per domain
- **Timeout**: 5 seconds per profile page
- **Fallback**: If profile fails, continue with team page data

### Phase 4: Data Merging
- Merge profile data with team page data
- Priority: Profile data > Team page data > Smart URL constructor

## Example: Sequoia Capital

### Team Page
URL: `https://sequoiacap.com/our-team/`
Team members: Bogomil Balkansky, Julien Bek, Roelof Botha, etc.

### Profile Page (Konstantine Buhler)
URL: `https://sequoiacap.com/people/konstantine-buhler/`

**Extracted Data:**
- Name: Konstantine Buhler
- Department: Seed/Early
- LinkedIn: `https://www.linkedin.com/in/konstantinebuhler/`
- Email: `kbuhler@sequoiacap.com`
- Portfolio Investments:
  - CaptivateIQ (Growth stage, co-investors: Mark Schopmeyer, Conway Teng, Hubert Wong)
  - Citadel Securities (Growth stage, co-investors: Ken Griffin, Peng Zhao)
  - Draftea (Growth stage, co-investors: Joe Cohen, Alan Jaime)
  - Dust (Early stage, co-investors: Gabriel Hubert, Stanislas Polu)
  - EDX Markets (Pre-Seed/Seed stage, co-investor: Jamil Nazarali)
  - Enter (Pre-Seed/Seed stage, co-investors: Mateus Costa-Ribeiro, Michael Mac-Vicar, Henrique Vaz)

## Technical Implementation

### New Module: `server/scraper/DeepCrawler.ts`
```typescript
export interface ProfileData {
  linkedinUrl?: string;
  email?: string;
  portfolioInvestments?: PortfolioInvestment[];
}

export interface PortfolioInvestment {
  companyName: string;
  stage?: string;
  description?: string;
  coInvestors?: string[];
}

export async function crawlTeamMemberProfile(
  profileUrl: string,
  memberName: string
): Promise<ProfileData>
```

### Integration Point
Modify `server/comprehensiveTeamExtraction.ts`:
- After extracting team members from team page
- Before matching LinkedIn URLs
- Call `crawlTeamMemberProfile()` for each member with a profile link

## Performance Impact
- **Current**: ~5-10 seconds per firm (1 team page)
- **With deep crawling**: ~15-30 seconds per firm (1 team page + 10-20 profile pages)
- **Mitigation**: Parallel processing + caching

## Rollout Strategy
1. Implement profile link detection
2. Implement profile page extraction
3. Test with Sequoia (known structure)
4. Add as **optional feature** (user can enable/disable)
5. Monitor performance and adjust timeouts
