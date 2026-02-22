# Advanced Scraper Architecture Design

## Overview

Multi-strategy scraping system with intelligent fallbacks, designed to handle any website architecture from static HTML to heavily protected JavaScript-rendered sites.

## Core Principles

1. **Strategy Cascade**: Try fastest method first, fall back to more powerful methods
2. **Resource Efficiency**: Reuse browser instances, cache aggressively
3. **Resilience**: Retry logic, circuit breakers, graceful degradation
4. **Observability**: Comprehensive logging and metrics
5. **Compliance**: Rate limiting, robots.txt respect, ethical scraping

## Component Architecture

```
ScrapingRequest
       ↓
StrategySelector (decides which method to use)
       ↓
   ┌───┴───┬────────┬──────────┐
   ↓       ↓        ↓          ↓
 API   Static   Browser   Stealth
Inter  HTML    Headless   Browser
ceptor Scraper  Scraper   Scraper
   ↓       ↓        ↓          ↓
   └───┬───┴────────┴──────────┘
       ↓
ContentExtractor (parse & validate)
       ↓
   CacheLayer
       ↓
    Result
```

## Strategy Levels

### Level 1: API Interception (Fastest - 50-200ms)
**When to use**: Site loads data via JSON/GraphQL endpoints
**Success rate**: 20-30% of sites
**Implementation**:
- Inspect Network tab for XHR/Fetch requests
- Replicate exact headers, cookies, parameters
- Parse JSON directly (no HTML parsing needed)

**Example patterns**:
- `/api/team`
- `/wp-json/wp/v2/team`
- GraphQL endpoints
- REST APIs

### Level 2: Static HTML Scraping (Fast - 200-500ms)
**When to use**: Traditional server-rendered sites
**Success rate**: 20-30% of modern sites
**Implementation**:
- Simple HTTP GET with axios
- Parse with Cheerio (jQuery-like selectors)
- Timeout after 3 seconds if no content found

### Level 3: Headless Browser (Comprehensive - 2-5s)
**When to use**: JavaScript-rendered sites (React, Vue, Angular)
**Success rate**: 80-90% of sites
**Implementation**:
- Puppeteer with stealth plugin
- Wait for network idle or specific selectors
- Execute JavaScript, handle dynamic content
- Scroll to trigger lazy loading

### Level 4: Stealth Browser (Maximum Compatibility - 5-10s)
**When to use**: Sites with strong anti-bot protection
**Success rate**: 95%+ of sites
**Implementation**:
- Full stealth mode (fingerprint spoofing)
- Human-like behavior simulation
- Proxy rotation
- CAPTCHA detection (alert user, don't auto-solve)

## Module Breakdown

### 1. StrategySelector
```typescript
interface ScrapingStrategy {
  name: string;
  priority: number;
  canHandle: (url: string, context: ScrapingContext) => Promise<boolean>;
  execute: (url: string, options: ScrapingOptions) => Promise<ScrapingResult>;
}
```

**Decision logic**:
1. Check cache first (return if fresh)
2. Try API interception (if patterns detected)
3. Try static HTML (timeout 3s)
4. Use headless browser (default)
5. Escalate to stealth mode (if blocked)

### 2. BrowserPool
**Purpose**: Reuse expensive browser instances

**Features**:
- Pool of 3-5 browser instances
- Lazy initialization
- Automatic cleanup after 5 minutes idle
- Memory monitoring (close if > 500MB per instance)

**Implementation**:
```typescript
class BrowserPool {
  private browsers: Browser[] = [];
  private maxBrowsers = 5;
  
  async acquire(): Promise<Browser>
  async release(browser: Browser): Promise<void>
  async cleanup(): Promise<void>
}
```

### 3. RequestManager
**Purpose**: Rate limiting, retries, circuit breaker

**Features**:
- Rate limit: 1-2 requests/second per domain
- Retry: 3 attempts with exponential backoff (1s, 2s, 4s)
- Circuit breaker: Stop requests if 50% fail in 1 minute
- Request queue with priority

### 4. ContentExtractor
**Purpose**: Parse HTML and extract structured data

**Strategies**:
1. **CSS Selectors**: Fast, works for consistent structures
2. **XPath**: More powerful, handles complex DOM
3. **LLM-based**: For inconsistent/unstructured content

**Team Member Extraction**:
```typescript
interface TeamMemberExtractor {
  extractFromHTML(html: string): TeamMember[];
  extractFromJSON(data: any): TeamMember[];
  extractWithLLM(html: string): Promise<TeamMember[]>;
}
```

### 5. CacheLayer
**Purpose**: Reduce redundant requests

**Strategy**:
- Team pages: 30 days TTL
- Company info: 7 days TTL
- Failed requests: 1 hour TTL (retry after)
- Storage: Redis or in-memory (for MVP)

### 6. StealthEngine
**Purpose**: Evade anti-bot detection

**Techniques**:
- **puppeteer-extra-plugin-stealth**: Automatic evasion
- **User-Agent rotation**: Realistic browser identities
- **Viewport randomization**: Different screen sizes
- **Timezone/locale spoofing**: Match proxy location
- **WebRTC leak prevention**: Hide real IP
- **Canvas fingerprint randomization**: Unique fingerprints

## Error Handling

### Retry Strategy
```
Attempt 1: Fast method (static HTML)
  ↓ (fail)
Attempt 2: Browser method (wait 1s)
  ↓ (fail)
Attempt 3: Stealth method (wait 2s)
  ↓ (fail)
Mark as failed, cache for 1 hour
```

### Circuit Breaker
```
If domain fails 5 times in a row:
  → Pause scraping for 5 minutes
  → Alert monitoring system
  → Try with different strategy next time
```

## Performance Targets

- **API Interception**: < 500ms per page
- **Static HTML**: < 1s per page
- **Headless Browser**: < 5s per page
- **Stealth Browser**: < 10s per page

**Throughput**:
- 10-20 concurrent requests
- 100-200 pages per minute (mixed strategies)
- 6,000-12,000 pages per hour

## Monitoring & Observability

### Metrics to Track
- Success rate by strategy
- Average response time by strategy
- Cache hit rate
- Browser pool utilization
- Memory usage per browser
- Failed requests by error type

### Logging
```typescript
interface ScrapingLog {
  url: string;
  strategy: string;
  duration: number;
  success: boolean;
  error?: string;
  cacheHit: boolean;
  retryCount: number;
}
```

## Implementation Plan

### Phase 1: Core Infrastructure
1. StrategySelector with fallback logic
2. BrowserPool with lifecycle management
3. RequestManager with rate limiting
4. Basic ContentExtractor

### Phase 2: Advanced Features
1. API interception detection
2. Stealth mode with fingerprint evasion
3. LLM-based content extraction
4. Advanced caching

### Phase 3: Production Hardening
1. Comprehensive error handling
2. Circuit breaker implementation
3. Monitoring dashboard
4. Performance optimization

## File Structure

```
server/scraper/
├── index.ts                 # Main entry point
├── StrategySelector.ts      # Strategy selection logic
├── strategies/
│   ├── ApiInterceptor.ts    # Level 1: API interception
│   ├── StaticScraper.ts     # Level 2: Static HTML
│   ├── BrowserScraper.ts    # Level 3: Headless browser
│   └── StealthScraper.ts    # Level 4: Stealth mode
├── BrowserPool.ts           # Browser instance management
├── RequestManager.ts        # Rate limiting & retries
├── ContentExtractor.ts      # HTML/JSON parsing
├── CacheLayer.ts            # Caching logic
├── StealthEngine.ts         # Anti-detection techniques
└── types.ts                 # TypeScript interfaces
```
