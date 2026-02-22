# Sequoia Capital Team Page Analysis

## URL
https://www.sequoiacap.com/people/ (redirects to https://sequoiacap.com/our-team/?_role=seed-early)

## Key Findings

### Page Structure
- Team members displayed as cards with photos
- Format: **Name** + **Department** (e.g., "BOGOMIL BALKANSKY - SEED/EARLY", "ROELOF BOTHA - SEED/EARLY + GROWTH")
- Filterable by role: SEED/EARLY, GROWTH, OPERATOR
- **NO explicit job titles** - only departments shown

### Team Members Found (Sample)
- **BOGOMIL BALKANSKY** - SEED/EARLY
- **JULIEN BEK** - SEED/EARLY
- **ROELOF BOTHA** - SEED/EARLY + GROWTH
- **KONSTANTINE BUHLER** - SEED/EARLY
- **JOSEPHINE CHEN** - SEED/EARLY
- **BILL COUGHRAN** - SEED/EARLY
- **CHARLIE CURNIN** - SEED/EARLY
- **JIM GOETZ** - SEED/EARLY + GROWTH
- **JESS LEE** - SEED/EARLY

### Issues with Current Scraper
1. **Department-only format**: "SEED/EARLY" instead of job titles like "Partner" or "Principal"
2. **JavaScript rendering**: Team member cards loaded dynamically
3. **No LinkedIn URLs**: Page doesn't include LinkedIn links
4. **LLM extraction**: Will extract "SEED/EARLY" or "GROWTH" as the title

### Why Scraper is Failing
- LLM extracts "SEED/EARLY" or "GROWTH" as title
- These don't match our department patterns ("investing", "investment team", etc.)
- Get classified as "Exclude" → filtered out
- Result: 0 team members

### Solution Needed
Add these patterns to department-based classification:
- "seed/early"
- "seed"
- "early stage"
- "growth"
- "growth stage"

These are all investment roles and should be classified as Tier 1.
