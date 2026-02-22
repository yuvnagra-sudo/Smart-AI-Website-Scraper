# a16z Investment Mandate Analysis

## What Should Be Extracted from /about page:

### Investment Mandate (Key Data Points)
1. **Firm Type**: Venture Capital
2. **AUM**: $90B+ under management across multiple funds
3. **Stage**: Stage agnostic - Seed to Venture to Growth-stage
4. **Sectors/Niches**:
   - Bio + Healthcare
   - Consumer apps
   - Enterprise apps
   - Crypto
   - Fintech
   - Infrastructure
   - American Dynamism
5. **Investment Philosophy**: 
   - Back bold entrepreneurs building the future through technology
   - Invest in magnitude of strength, not lack of weaknesses
   - Asymmetric bets - focus on upside potential

### What the Current Scraper Likely Misses:
1. The detailed investment thesis/philosophy
2. The specific sectors listed (bio, consumer, enterprise, crypto, fintech, infrastructure)
3. The AUM figure ($90B)
4. The stage-agnostic approach

## Current LLM Prompt Issues:

The current prompts likely:
1. Focus too much on team member extraction
2. Don't explicitly ask for investment mandate/thesis
3. Don't extract AUM or fund size
4. Don't capture the detailed sector focus

## Recommended Prompt Improvements:

1. Add explicit fields for:
   - `investment_thesis` - The firm's stated investment philosophy
   - `aum` - Assets under management
   - `fund_stages` - Which stages they invest in
   - `sector_focus` - Detailed list of sectors/niches
   - `geographic_focus` - Any geographic preferences

2. Instruct LLM to look for:
   - "We invest in..." statements
   - "Our focus is..." statements
   - Dollar amounts related to fund size
   - Stage terminology (seed, Series A, growth, etc.)
