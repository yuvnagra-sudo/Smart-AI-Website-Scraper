# Web Scraping Techniques Research - 2025

## Executive Summary

Modern web scraping requires a multi-layered approach to handle diverse website architectures, from static HTML to JavaScript-heavy SPAs, with anti-bot protection. Production-grade scrapers need multiple strategies with intelligent fallbacks.

## Key Findings

### 1. Website Architecture Types

**Static HTML Sites (Legacy)**
- Traditional server-rendered HTML
- Content available in initial HTTP response
- Tools: Beautiful Soup, Cheerio, basic HTTP clients
- Fastest to scrape, but increasingly rare

**JavaScript-Rendered Sites (Modern Standard)**
- React, Vue, Angular, Svelte SPAs
- Content loaded dynamically via JavaScript
- Requires browser execution or API interception
- Tools: Puppeteer, Playwright, Selenium

**Server-Side Rendered (SSR) Sites**
- Next.js, Nuxt.js, SvelteKit
- Hybrid: Initial HTML + client-side hydration
- May work with static scraping but often needs JS execution

**Dynamic Content Loading**
- Infinite scroll (social media, product listings)
- Lazy loading images/content
- AJAX requests for additional data
- Requires scroll simulation or API interception

### 2. Scraping Strategy Hierarchy

**Level 1: API Interception (Most Efficient)**
- Inspect Network tab in DevTools
- Find JSON/GraphQL endpoints that power the UI
- Replicate API calls directly (bypass HTML parsing)
- 10-100x faster than browser automation
- Example: Instead of scraping LinkedIn UI, call their internal API

**Level 2: Static HTML Scraping (Fast)**
- Standard HTTP GET request
- Parse HTML with lightweight libraries
- Works for 20-30% of modern sites
- Minimal resource usage

**Level 3: Headless Browser (Comprehensive)**
- Full browser environment (Puppeteer/Playwright)
- Executes JavaScript, handles dynamic content
- Slower but handles 95%+ of sites
- Resource intensive (CPU/memory)

**Level 4: Full Browser with Stealth (Anti-Bot Bypass)**
- Browser with stealth plugins
- Mimics real user behavior
- Handles CAPTCHA, fingerprinting detection
- Slowest but most reliable

### 3. Anti-Bot Protection Techniques

**Detection Methods Sites Use:**
- User-Agent analysis
- Browser fingerprinting (canvas, WebGL, fonts)
- TLS fingerprinting
- Mouse movement patterns
- Request timing analysis
- IP reputation checks
- CAPTCHA challenges
- Honeypot traps (hidden links/forms)

**Bypass Strategies:**
- **Proxy Rotation**: Residential > Mobile > Datacenter proxies
- **User-Agent Rotation**: Mimic real browsers
- **Request Timing**: Random delays between requests (1-5 seconds)
- **Browser Fingerprint Spoofing**: Stealth plugins (puppeteer-extra-plugin-stealth)
- **Human-like Behavior**: Bézier curve mouse movements, realistic scrolling
- **Cookie Management**: Maintain session state
- **Header Consistency**: Match real browser headers exactly

### 4. Production Architecture Components

**Core Components:**

1. **Request Manager**
   - Queue management
   - Rate limiting (requests per second)
   - Retry logic with exponential backoff
   - Circuit breaker pattern

2. **Strategy Selector**
   - Detect website type (static vs dynamic)
   - Choose appropriate scraping method
   - Fallback cascade on failure

3. **Browser Pool**
   - Reuse browser instances (expensive to create)
   - Connection pooling
   - Resource cleanup

4. **Content Extractor**
   - HTML parsing (CSS selectors, XPath)
   - LLM-based extraction for unstructured content
   - Schema validation

5. **Cache Layer**
   - Cache successful responses (TTL-based)
   - Reduce redundant requests
   - Respect cache headers

6. **Monitoring & Logging**
   - Track success/failure rates
   - Detect site structure changes
   - Alert on anomalies

### 5. Modern Tools & Libraries

**Node.js/TypeScript (Recommended for VC platform):**
- **Puppeteer**: Chrome/Chromium automation, official Google project
- **Playwright**: Multi-browser (Chrome, Firefox, Safari), Microsoft-backed
- **Cheerio**: Fast HTML parsing (jQuery-like syntax)
- **Axios**: HTTP client with interceptors
- **puppeteer-extra-plugin-stealth**: Anti-detection plugin

**Python (Alternative):**
- **Scrapy**: Full-featured framework for large-scale crawling
- **Selenium**: Industry standard browser automation
- **Beautiful Soup**: HTML/XML parsing
- **Playwright-Python**: Python bindings for Playwright

### 6. Specific Techniques for VC Team Pages

**Challenge**: VC websites vary wildly in structure
- Some use WordPress with static HTML
- Others use React/Next.js with dynamic loading
- Many use custom CMS systems
- Team pages may be /team, /people, /about/team, /our-team

**Solution: Multi-Strategy Approach**

1. **Try API interception first**
   - Check if site loads team data via JSON endpoint
   - Common patterns: `/api/team`, `/wp-json/wp/v2/team`

2. **Attempt static HTML scraping**
   - Fast, works for 30% of sites
   - Timeout after 5 seconds if no content

3. **Use headless browser**
   - Wait for JavaScript execution (2-5 seconds)
   - Scroll to trigger lazy loading
   - Extract rendered HTML

4. **LLM-based extraction**
   - For sites with inconsistent structure
   - Feed HTML to LLM with extraction prompt
   - More expensive but handles edge cases

### 7. Performance Optimization

**Parallel Processing:**
- Scrape multiple firms concurrently (10-20 at a time)
- Use worker pools for browser instances
- Balance speed vs. detection risk

**Resource Management:**
- Close browser tabs after use
- Limit concurrent browser instances (5-10 max)
- Monitor memory usage (browsers are heavy)

**Caching Strategy:**
- Cache team pages for 30 days (people don't change often)
- Cache company info for 7 days
- Invalidate on user request

### 8. Legal & Ethical Considerations

**Must Follow:**
- Respect robots.txt
- Honor rate limits
- Don't overload servers
- Identify your bot (User-Agent)
- Comply with Terms of Service
- GDPR compliance for EU data

**Best Practices:**
- 1-2 requests per second per domain
- Use official APIs when available
- Cache aggressively to reduce load
- Provide opt-out mechanism

## Recommended Implementation for VC Platform

### Architecture Design

```
┌─────────────────────────────────────────┐
│         Scraping Request                │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│      Strategy Selector                  │
│  - Detect site type                     │
│  - Choose scraping method               │
└────────────────┬────────────────────────┘
                 │
        ┌────────┴────────┐
        │                 │
        ▼                 ▼
┌──────────────┐  ┌──────────────┐
│ API          │  │ Browser      │
│ Interceptor  │  │ Scraper      │
└──────┬───────┘  └──────┬───────┘
       │                 │
       └────────┬────────┘
                │
                ▼
┌─────────────────────────────────────────┐
│      Content Extractor                  │
│  - Parse HTML                           │
│  - Extract team members                 │
│  - Validate data                        │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│         Cache & Return                  │
└─────────────────────────────────────────┘
```

### Priority Features

**Phase 1 (Immediate):**
1. API interception for common CMS platforms
2. Enhanced browser scraping with stealth mode
3. Intelligent retry logic
4. Request rate limiting

**Phase 2 (Next):**
1. Proxy rotation support
2. CAPTCHA detection (not solving, just detection)
3. Site structure change detection
4. Performance monitoring dashboard

**Phase 3 (Future):**
1. ML-based content extraction
2. Distributed scraping (multiple servers)
3. Real-time scraping (WebSocket support)
4. Advanced fingerprint evasion

## Sources Consulted

1. AIMultiple - "10 Web Scraping Techniques & Tools" (Aug 2025)
2. Oxylabs - "Advanced Web Scraping With Python Tactics in 2025" (Jan 2025)
3. ScrapFly - "How to Scrape Dynamic Websites Using Headless Web Browsers" (Sep 2025)
4. Browserbase - "Top 10 Web Scraping Tools for 2025" (Nov 2025)
5. Zyte - "The best way to architect web scraping solutions"
