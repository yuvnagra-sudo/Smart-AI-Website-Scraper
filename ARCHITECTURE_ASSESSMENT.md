# Architectural Assessment: Smart AI Data Scraper vs. Truly Agentic Systems

**Date:** March 2026  
**Scope:** Full audit of `agentScraper.ts`, `directoryExtractor.ts`, `routers.ts`, and the LLM pipeline, compared against Firecrawl `/agent`, Fire Enrich, and the Plan-Act-Observe agentic loop pattern.

---

## Executive Summary

The current scraper is a **well-engineered pipeline**, not a true agent. It is intelligent in the sense that it uses an LLM to classify pages and decide which links to follow — but its intelligence is **stateless, single-pass, and reactive**. It does not plan, it does not reflect on whether its results are good enough, and it does not adapt its strategy based on what it has found so far. These are the fundamental gaps that explain all three of the original reported issues and the 100%+ problem.

The good news: the architecture is close. The primitives are all there. What is missing is a **reasoning loop** that wraps them.

---

## What a True Agentic Scraper Does

Firecrawl's `/agent` endpoint and Fire Enrich both implement a **Plan → Act → Observe → Reflect** loop:

| Step | What happens |
|---|---|
| **Plan** | Given the user's goal and the current state of extracted data, the LLM decides *what to do next* — which URL to visit, which search to run, or whether to stop |
| **Act** | Execute the decided action (fetch a page, run a web search, click a button) |
| **Observe** | Read the result and update the agent's working memory (what has been found so far) |
| **Reflect** | Ask: "Do I have enough data? Are there gaps? What should I do next?" — then loop back to Plan |

This loop is what gives an agent the ability to **know when to stop**. It stops not because a counter hits a limit, but because the LLM itself evaluates the current state and concludes "I have found everything the user asked for." It also means the agent naturally handles directories, sub-pages, and pagination — not as special cases, but as just more actions in the loop.

Fire Enrich takes this further by deploying **specialized sub-agents** per data domain (a Company Research Agent, a Fundraising Intelligence Agent, a People & Leadership Agent, etc.). Each sub-agent is an expert in its domain and knows exactly what sources to search and what signals indicate success.

---

## What the Current Scraper Does Instead

The current scraper implements a **fixed 4-step pipeline** per URL:

```
1. Fetch page (Jina → Puppeteer fallback)
2. Classify page (directory / directory-entry / profile) — ONE LLM call
3. If profile: extract all fields in ONE LLM call, then follow up to 5 sub-links
4. Done. Move to next URL.
```

There is no loop. There is no reflection. The scraper visits a page, makes one classification decision, makes one extraction call, follows a fixed number of hops, and moves on — regardless of whether the data it found is complete, partial, or completely wrong.

### The Seven Fundamental Limitations

**1. The classifier is the single point of failure.**

Every URL goes through `classifyPage()`, which makes a single LLM call on the first 20,000 characters of content. If this call is wrong — and it frequently is, because many company homepages have listing-style sections that look like directories — the entire downstream behavior for that URL is wrong. There is no second opinion, no confidence score, and no fallback strategy.

The current code has a hardcoded list of 6 known directory domains (`goodfirms.co`, `clutch.co`, `g2.com`, `yelp.com`, `capterra.com`, `trustpilot.com`). Any directory site not on this list gets no special treatment. The world has millions of industry-specific directories.

**2. Extraction is a single-shot call with no self-evaluation.**

`extractProfileFields()` makes one LLM call and returns whatever it gets. It never asks "is this answer good?" or "did I actually find this field or am I hallucinating a placeholder?" The system has no way to distinguish between a genuine empty field (the company doesn't publish that data) and a failed extraction (the data exists but the LLM missed it or the page was fetched incorrectly).

**3. The sub-link decision is made without knowing the full site structure.**

`decideNextLinks()` asks the LLM to pick up to 3 links from the current page's markdown. It only sees links that appear as `[text](url)` in the Jina markdown output — which misses JavaScript-rendered navigation, dropdowns, and dynamically loaded content. It also only looks at the current page, not the site's sitemap or robots.txt, so it has no awareness of where the most useful pages are likely to be.

**4. There is no web search fallback.**

If a company's website is down, blocked, or has no useful content, the scraper returns empty fields. A true agent would fall back to searching the web for the company name and extracting data from news articles, LinkedIn, Crunchbase, press releases, or other sources. The current system has no search capability at all.

**5. The directory classifier has no concept of "user intent."**

When a user uploads a list of company websites, they want profile data from those companies. They do not want the scraper to decide that one of those URLs is actually a directory and start scraping hundreds of other companies. The classifier has no way to know what the user intended — it only sees the page content. This is the root cause of the 100%+ bug. A true agent would ask: "The user gave me this URL as a company to enrich. Even if this page looks like a directory, my job is to extract data about *this entity*, not to crawl the directory."

**6. The LLM queue is a global singleton shared across all concurrent workers.**

All 10 concurrent workers share one `LLMQueue` instance with a single rate-limit counter. This means workers frequently queue behind each other waiting for LLM capacity, even when the rate limit has not actually been hit. A proper implementation would use per-worker queues with a global rate-limit coordinator, or use a streaming LLM API to process results as they arrive.

**7. There is no memory or learning within a job.**

If the scraper processes 100 companies in the same industry and finds that "About" pages consistently have the best data for the `company_description` field, it does not learn this and apply it to the remaining 900 companies. Every URL is processed identically from scratch. A true agent would build a strategy model as it processes the first few URLs and apply that strategy to the rest.

---

## Comparison Table

| Capability | Current Scraper | Firecrawl `/agent` | Recommended Redesign |
|---|---|---|---|
| **Stopping condition** | Hard cap + depth guard (heuristic) | LLM self-evaluates completion | LLM evaluates per-field confidence |
| **Page classification** | Single LLM call, no fallback | Browser agent, no pre-classification needed | Confidence-scored classification with fallback |
| **Extraction strategy** | Single-shot per page | Multi-step navigation loop | Iterative loop with self-evaluation |
| **Web search fallback** | None | Yes (searches the web) | Yes (DuckDuckGo/Serper API) |
| **User intent awareness** | None | Prompt-driven | Intent preserved per-row |
| **Sub-agent specialization** | None | None (single agent) | Domain-specific extractors per field group |
| **Source attribution** | None | Yes | Yes (track source URL per field) |
| **Handles JS-heavy sites** | Puppeteer fallback | Full browser agent | Puppeteer with smarter trigger |
| **Pagination** | Up to 500 pages (directory mode) | Automatic | Automatic with loop |
| **Memory within job** | None | None | Strategy cache per domain |

---

## Recommended Redesign: The Enrichment Agent Loop

The core change is replacing the fixed pipeline with a **per-company agent loop**. Here is the proposed architecture:

### Per-Company Agent Loop

```
GIVEN: companyName, websiteUrl, targetFields[], objective

STATE: { found: {field: value}, sources: {field: url}, confidence: {field: score}, hops: 0 }

LOOP:
  1. PLAN   — LLM evaluates STATE and decides next action:
              { action: "fetch_url" | "web_search" | "done", target: string, reason: string }
              
  2. ACT    — Execute the action (fetch page or run search)
  
  3. OBSERVE — Extract all targetFields from the fetched content
               Update STATE.found with any new/better values
               Update STATE.confidence (0.0–1.0 per field)
               
  4. REFLECT — If all fields have confidence ≥ 0.7, action = "done"
               If hops ≥ MAX_HOPS, action = "done"
               If action = "web_search" returned nothing, action = "done"
               Otherwise, loop back to PLAN
               
OUTPUT: STATE.found (with source URLs and confidence scores)
```

### Key Changes from Current Architecture

**Replace `classifyPage()` with intent-aware fetching.** The agent never needs to classify a page as a "directory" because it always knows its goal is to enrich *this specific company*. If it fetches a page and finds a list of other companies instead of data about the target, it simply notes "this page was not useful" and tries a different action.

**Add web search as a first-class action.** When the website has no useful content, the agent searches `"{companyName} {field}"` using the Serper API (or DuckDuckGo) and extracts from the results. This alone would dramatically improve fill rates for companies with minimal websites.

**Add per-field confidence scoring.** The LLM returns a confidence score (0–1) alongside each extracted value. The loop continues until all fields are above the threshold or the hop limit is reached. This replaces the current binary "found / not found" logic.

**Add source attribution.** Every extracted value records which URL it came from. This is critical for verification and is what Fire Enrich does that makes it trustworthy for sales and research workflows.

**Preserve user intent per row.** The agent is initialized with the knowledge that `websiteUrl` is the *target company's website*, not a directory to crawl. Directory expansion is a separate, opt-in mode.

### What This Fixes

| Original Issue | How the redesign fixes it |
|---|---|
| Columns not filled | Agent loops until confident, falls back to web search |
| Job immediately finishes | `keepAlive` fix (already done) + agent loop has natural completion signal |
| Cancel doesn't stop | Cancellation check at every loop iteration (already improved) |
| Job runs past 100% | Directory expansion is opt-in, not triggered by misclassification |
| Knows when to stop | LLM self-evaluates confidence — stops when done, not when a counter hits a limit |

---

## Implementation Effort

| Component | Effort | Risk |
|---|---|---|
| Per-company agent loop (replace `scrapeUrl`) | 2–3 days | Medium — core logic change |
| Per-field confidence scoring | 0.5 days | Low — prompt change only |
| Web search fallback (Serper/DuckDuckGo) | 1 day | Low — new API integration |
| Source attribution per field | 0.5 days | Low — data model change |
| Intent-aware fetching (remove `classifyPage`) | 0.5 days | Low — simplification |
| Domain strategy cache | 1 day | Low — in-memory optimization |
| **Total** | **~5–6 days** | |

This is a **targeted overhaul of `agentScraper.ts`** only. The job infrastructure (`worker.ts`, `routers.ts`, `enrichmentDb.ts`), the frontend, and the Excel export pipeline all stay the same. The interface between the agent and the job runner (`scrapeUrl()` → `AgentScrapeResult`) stays the same. Only the internals of how a single URL is processed changes.

---

## Recommendation

Implement the agent loop redesign. The current architecture has hit the ceiling of what a fixed pipeline can do — the bugs being reported are symptoms of the same root cause: the system does not reason about whether it has achieved its goal. The redesign is not a full rewrite; it is a focused replacement of the core extraction logic with something that actually thinks.

The web search fallback alone would likely double the fill rate for empty fields, since many companies have more information published about them (in press, LinkedIn, Crunchbase) than on their own websites.
