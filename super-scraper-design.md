# The "Super Scraper" Architecture

Merging the lightweight speed of deterministic extraction with the deep reasoning and resilience of the LLM agent loop.

## The Two Paradigms

**1. The Original Agent Loop (`agentScraper.ts`)**
- **Strengths:** Intelligent web search fallback, multi-hop reasoning (knows when to stop), context passing between hops, handles complex pagination and directories.
- **Weaknesses:** Very expensive (~7 LLM calls per firm), slow (sequential planning), uses LLM for trivial tasks like URL discovery.

**2. The Lightweight Engine (`lightweightScraper.ts`)**
- **Strengths:** Extremely fast, parallel page fetching, zero-cost URL discovery (sitemaps + heuristics), zero-cost deterministic extraction (JSON-LD, CSS, regex).
- **Weaknesses:** Rigid. If the deterministic patterns fail, it only has one chance (the optional LLM pass) to recover, and it cannot dynamically search the web or pivot to new domains if the homepage is a dead end.

## The Merged "Super Scraper" Architecture

We will build `superScraper.ts` as a **hybrid escalation engine**. It starts fast and cheap, and only escalates to expensive agentic reasoning when the cheap methods fail.

### Phase 1: Fast Discovery & Parallel Fetch (The Lightweight Front)
- **URL Discovery:** Use the lightweight heuristic mapper (`mapUrlsHeuristic`) + sitemap parsing to instantly find `/team`, `/about`, `/contact` without LLM calls.
- **Parallel Fetch:** Fetch the top 5-10 URLs concurrently using Jina/Puppeteer.
- **Deterministic Extraction:** Run JSON-LD, CSS, and Regex extractors across all fetched pages. Merge results by confidence.

### Phase 2: The Assessment Gate
- **Check Confidence:** Are all critical fields (especially Decision Maker name/email) at `CONFIDENCE >= 0.65`?
- **If Yes:** Stop here. Proceed to Enrichment Cascade. **Cost: $0.00**.
- **If No:** Escalate to Phase 3.

### Phase 3: Targeted LLM Extraction (The Bridge)
- **Targeted Prompt:** Take the pages fetched in Phase 1, chunk them, and ask the LLM to find *only* the missing fields.
- **Check Confidence:** Are we good now?
- **If Yes:** Stop here. **Cost: ~$0.002**.
- **If No:** Escalate to Phase 4.

### Phase 4: Agentic Escalation (The Heavy Lifter)
- **Dynamic Reasoning:** If we are *still* missing critical fields, the website might be a dead end, or the data is hidden elsewhere.
- **Web Search:** The agent takes over, dynamically generating web search queries (e.g., `"{Company Name}" CEO email site:linkedin.com`).
- **Multi-Hop:** It navigates search results, fetches new pages, and extracts until it finds the data or hits a strict hop limit (e.g., 3 hops).
- **Cost:** ~$0.01 - $0.02 (only incurred for the hardest ~20% of firms).

### Phase 5: Enrichment Cascade (The Closer)
- Run the standard cascade (Direct Email → Hunter.io → Apify LinkedIn → SMTP).

## Why this is the "Super Scraper"

1. **Cost Efficiency:** ~80% of firms have standard websites where Phase 1 + 2 will succeed. You pay $0 for these.
2. **Maximum Coverage:** For the 20% of firms with terrible websites, the agent loop kicks in and hunts down the data via Google/LinkedIn.
3. **Speed:** Parallel fetching upfront cuts average processing time in half.
4. **Deep Team Extraction:** The architecture natively supports escalating to `deepTeamProfileScraper` if a team page is found but requires clicking into individual bios.

## Next Steps
I will implement `superScraper.ts` following this exact 5-phase escalation model, wire it into `routers.ts`, and expose it via a new environment variable `USE_SUPER_SCRAPER=true`.
