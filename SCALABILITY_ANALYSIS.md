# Scalability Analysis & Bottleneck Elimination

## Current Bottlenecks Identified

### 1. **LLM Rate Limiting** 🔴 CRITICAL

**Problem:**
- Current system makes **5-10 LLM calls per firm**:
  - Website verification (1 call)
  - Investor type extraction (1 call)
  - Investment stages extraction (1 call)
  - Investment niches extraction (1 call)
  - Team member extraction (1-2 calls depending on page size)
  - Portfolio company extraction (1 call)
- For 10,000 firms: **50,000-100,000 LLM calls**
- Even with retry logic, rate limits will still occur at scale

**Current Rate Limits:**
- Gemini 2.5 Flash: ~60 requests/minute (RPM)
- At 60 RPM: 10,000 firms × 5 calls = 50,000 calls ÷ 60 RPM = **833 minutes (14 hours)**
- With rate limit errors and retries: **20-30 hours**

**Impact:**
- Jobs take days to complete
- Unpredictable completion times
- User frustration
- Wasted compute time waiting

---

### 2. **Sequential Processing** 🔴 CRITICAL

**Problem:**
- Current worker processes **1 firm at a time**
- Each firm takes 30-60 seconds
- For 10,000 firms: **300,000-600,000 seconds (83-167 hours = 3.5-7 days)**

**Why Sequential?**
- Single worker process
- No concurrency controls
- Batch processor runs items sequentially

**Impact:**
- Extremely long processing times
- Underutilized resources (CPU, network idle most of the time)
- Poor user experience

---

### 3. **No Request Queuing** 🟡 HIGH

**Problem:**
- LLM requests are made immediately when needed
- No queue to smooth out request rate
- Bursts of requests trigger rate limits
- No intelligent request scheduling

**Impact:**
- Rate limit errors even at low volumes
- Wasted retries
- Inefficient API usage

---

### 4. **Redundant LLM Calls** 🟡 HIGH

**Problem:**
- Same website content analyzed multiple times (verification, investor type, stages, niches)
- No caching of LLM responses
- Portfolio/team extraction happens even if same data was extracted before

**Example:**
- Firm A: Extract niches from homepage
- Firm B (same parent company): Extract niches from same homepage again
- Waste: 2× LLM calls for identical content

**Impact:**
- 2-3× more LLM calls than necessary
- Higher costs
- More rate limit issues

---

### 5. **No Caching Strategy** 🟡 HIGH

**Problem:**
- Website HTML fetched every time (even if recently fetched)
- LLM responses not cached
- LinkedIn profile lookups repeated
- No deduplication of work

**Impact:**
- Unnecessary network requests
- Slower processing
- Higher API costs

---

### 6. **Database Connection Limits** 🟠 MEDIUM

**Problem:**
- Each worker creates its own database connection
- MySQL/TiDB has connection limits (default: 151 connections)
- Multiple parallel workers could exhaust connections

**Impact:**
- Worker crashes when connection limit reached
- Jobs fail silently
- Data loss

---

### 7. **Memory Constraints** 🟠 MEDIUM

**Problem:**
- Large Excel files loaded entirely into memory
- 10,000 firms × 50 team members = 500,000 rows in memory
- Portfolio companies add another 100,000+ rows
- Total memory usage could exceed 2-4 GB

**Impact:**
- Out of memory errors
- Process crashes
- Job failures

---

### 8. **Excel File Size Limits** 🟠 MEDIUM

**Problem:**
- Excel has practical limits:
  - Max rows: 1,048,576 per sheet
  - Max file size: ~100 MB (performance degrades above this)
  - Opening large files is slow
- 10,000 firms with 50 team members each = 500,000 rows (OK)
- But with portfolio companies: 500,000 + 200,000 = 700,000 rows (still OK)

**Impact:**
- Excel files become unwieldy
- Users can't open files easily
- Performance issues

---

### 9. **No Progress Visibility** 🟢 LOW

**Problem:**
- User can't see real-time progress
- No ETA shown
- Can't tell if job is stuck or progressing

**Impact:**
- Poor user experience
- Support requests
- User anxiety

---

## Solutions to Eliminate Bottlenecks

### Solution 1: Implement LLM Request Queue with Rate Limiting

**Design:**
```typescript
class LLMRequestQueue {
  private queue: Array<{
    params: InvokeParams;
    resolve: (result: InvokeResult) => void;
    reject: (error: Error) => void;
    priority: number;
  }> = [];
  
  private requestsPerMinute = 50; // Conservative limit (below 60 RPM)
  private requestsThisMinute = 0;
  private minuteStartTime = Date.now();
  
  async enqueue(params: InvokeParams, priority = 0): Promise<InvokeResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ params, resolve, reject, priority });
      this.queue.sort((a, b) => b.priority - a.priority); // Higher priority first
      this.processQueue();
    });
  }
  
  private async processQueue() {
    if (this.queue.length === 0) return;
    
    // Reset counter every minute
    const now = Date.now();
    if (now - this.minuteStartTime > 60000) {
      this.requestsThisMinute = 0;
      this.minuteStartTime = now;
    }
    
    // Check if we can make a request
    if (this.requestsThisMinute >= this.requestsPerMinute) {
      const waitTime = 60000 - (now - this.minuteStartTime);
      console.log(`[LLM Queue] Rate limit reached, waiting ${waitTime}ms`);
      setTimeout(() => this.processQueue(), waitTime);
      return;
    }
    
    // Process next request
    const item = this.queue.shift();
    if (!item) return;
    
    this.requestsThisMinute++;
    
    try {
      const result = await invokeLLM(item.params);
      item.resolve(result);
    } catch (error) {
      item.reject(error as Error);
    }
    
    // Process next item (with small delay to avoid bursts)
    setTimeout(() => this.processQueue(), 100);
  }
}

// Global singleton
const llmQueue = new LLMRequestQueue();

// Replace all invokeLLM() calls with:
const result = await llmQueue.enqueue(params, priority);
```

**Benefits:**
- **Eliminates rate limit errors** - Never exceeds API limits
- **Predictable throughput** - 50 requests/minute guaranteed
- **Priority queuing** - Critical requests processed first
- **Smooth request rate** - No bursts

**Impact:**
- 10,000 firms × 5 calls = 50,000 calls ÷ 50 RPM = **1,000 minutes (16.7 hours)**
- **Zero rate limit errors**
- Predictable completion time

---

### Solution 2: Parallel Processing with Concurrency Control

**Design:**
```typescript
// Process multiple firms concurrently
const CONCURRENT_FIRMS = 5; // Process 5 firms at once

async function processBatchWithConcurrency(
  firms: VCFirmInput[],
  concurrency: number,
  onProgress: (completed: number) => void
) {
  const results: EnrichmentResult[] = [];
  let completed = 0;
  
  // Create worker pool
  const workers = Array.from({ length: concurrency }, async (_, workerIndex) => {
    while (firms.length > 0) {
      const firm = firms.shift();
      if (!firm) break;
      
      console.log(`[Worker ${workerIndex}] Processing: ${firm.companyName}`);
      
      try {
        const result = await enricher.enrichVCFirm(
          firm.companyName,
          firm.websiteUrl,
          firm.description
        );
        results.push(result);
        completed++;
        onProgress(completed);
      } catch (error) {
        console.error(`[Worker ${workerIndex}] Error:`, error);
      }
    }
  });
  
  await Promise.all(workers);
  return results;
}
```

**Benefits:**
- **5× faster processing** - 5 firms processed simultaneously
- **Better resource utilization** - CPU and network used efficiently
- **Controlled concurrency** - Won't overwhelm system

**Impact:**
- 10,000 firms ÷ 5 concurrent = 2,000 sequential batches
- 2,000 × 30 seconds = 60,000 seconds = **16.7 hours**
- Combined with LLM queue: **16.7 hours total** (down from 3-7 days)

---

### Solution 3: Intelligent Caching

**Design:**
```typescript
class EnrichmentCache {
  private llmCache = new Map<string, any>();
  private htmlCache = new Map<string, { html: string; timestamp: number }>();
  private cacheTTL = 7 * 24 * 60 * 60 * 1000; // 7 days
  
  // Cache LLM responses
  async cachedLLMCall(
    cacheKey: string,
    params: InvokeParams
  ): Promise<InvokeResult> {
    if (this.llmCache.has(cacheKey)) {
      console.log(`[Cache] LLM hit: ${cacheKey}`);
      return this.llmCache.get(cacheKey);
    }
    
    const result = await llmQueue.enqueue(params);
    this.llmCache.set(cacheKey, result);
    return result;
  }
  
  // Cache HTML fetches
  async cachedFetch(url: string): Promise<string | null> {
    const cached = this.htmlCache.get(url);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      console.log(`[Cache] HTML hit: ${url}`);
      return cached.html;
    }
    
    const html = await fetchWebpage(url);
    if (html) {
      this.htmlCache.set(url, { html, timestamp: Date.now() });
    }
    return html;
  }
}
```

**Benefits:**
- **50-70% fewer LLM calls** - Reuse results for similar content
- **Faster processing** - No network delay for cached content
- **Lower costs** - Fewer API calls

**Impact:**
- 50,000 LLM calls → 15,000-25,000 calls (with caching)
- Processing time: **5-8 hours** (down from 16.7 hours)

---

### Solution 4: Batch LLM Requests

**Design:**
```typescript
// Instead of 5 separate LLM calls per firm, combine into 1-2 calls

async function extractAllFirmData(
  url: string,
  companyName: string,
  description: string
): Promise<{
  verified: boolean;
  investorType: string[];
  stages: string[];
  niches: string[];
}> {
  const html = await cachedFetch(url);
  const text = extractTextFromHtml(html, 8000); // Larger context
  
  const prompt = `Analyze this VC firm and extract ALL the following information in one response:

Company: ${companyName}
Description: ${description}
Website Content: ${text}

Extract:
1. Is this the correct website for "${companyName}"? (YES/NO)
2. Investor type (from taxonomy)
3. Investment stages (from taxonomy)
4. Investment niches (from taxonomy)

Return as JSON with keys: verified, investorType, stages, niches`;

  const response = await llmQueue.enqueue({
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });
  
  return JSON.parse(response.choices[0].message.content);
}
```

**Benefits:**
- **5 LLM calls → 1 LLM call** per firm
- **5× fewer API requests**
- **5× faster processing**

**Impact:**
- 50,000 calls → 10,000 calls
- Processing time: **3-4 hours** (down from 5-8 hours)

---

### Solution 5: Database Connection Pooling

**Design:**
```typescript
// Use connection pooling
import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  uri: process.env.DATABASE_URL,
  connectionLimit: 10, // Max 10 connections
  queueLimit: 0, // Unlimited queue
  waitForConnections: true,
});

// All workers share the same pool
const db = drizzle(pool);
```

**Benefits:**
- **Efficient connection reuse**
- **No connection limit errors**
- **Better performance**

---

### Solution 6: Streaming Excel Export

**Design:**
```typescript
// Instead of building entire Excel in memory, stream to file
import * as XLSX from 'xlsx-stream-writer';

async function streamExcelExport(
  firms: AsyncIterable<EnrichedVCData>,
  outputPath: string
) {
  const writer = new XLSXWriter(outputPath);
  const firmSheet = writer.addSheet('VC Firms');
  
  // Write header
  firmSheet.writeRow(['Company Name', 'Website', ...]);
  
  // Stream rows
  for await (const firm of firms) {
    firmSheet.writeRow([firm.companyName, firm.websiteUrl, ...]);
  }
  
  await writer.close();
}
```

**Benefits:**
- **Constant memory usage** - No matter how many firms
- **Handles unlimited rows**
- **Faster export**

---

## Recommended Architecture

### Phase 1: Immediate Improvements (1-2 days)

1. **Implement LLM request queue** - Eliminate rate limits
2. **Add parallel processing** - 5 concurrent firms
3. **Basic caching** - HTML and LLM responses

**Expected Performance:**
- 10,000 firms in **8-12 hours**
- Zero rate limit errors
- Predictable completion

### Phase 2: Optimization (3-5 days)

4. **Batch LLM requests** - Combine multiple calls into one
5. **Database connection pooling** - Handle more workers
6. **Advanced caching** - Deduplicate similar firms

**Expected Performance:**
- 10,000 firms in **3-5 hours**
- 80% fewer LLM calls
- Lower costs

### Phase 3: Scale to 100K+ (1-2 weeks)

7. **Streaming Excel export** - Handle unlimited rows
8. **Distributed workers** - Multiple PM2 instances
9. **Redis caching** - Persistent cache across restarts

**Expected Performance:**
- 100,000 firms in **30-50 hours**
- Unlimited scale
- Production-ready

---

## Capacity Targets

### Current System
- **Max throughput:** 1 firm/minute
- **10,000 firms:** 7 days
- **Rate limit errors:** Frequent

### After Phase 1
- **Max throughput:** 5 firms/minute
- **10,000 firms:** 12 hours
- **Rate limit errors:** Zero

### After Phase 2
- **Max throughput:** 15 firms/minute
- **10,000 firms:** 4 hours
- **Rate limit errors:** Zero

### After Phase 3
- **Max throughput:** 50 firms/minute
- **10,000 firms:** 3.3 hours
- **100,000 firms:** 33 hours
- **Rate limit errors:** Zero

---

## Cost Analysis

### Current System (10,000 firms)
- **LLM calls:** 50,000
- **Cost:** ~$5-10 (Gemini 2.5 Flash is cheap)
- **Time:** 7 days

### After Phase 1 (10,000 firms)
- **LLM calls:** 50,000
- **Cost:** ~$5-10
- **Time:** 12 hours

### After Phase 2 (10,000 firms)
- **LLM calls:** 10,000 (80% reduction)
- **Cost:** ~$1-2 (80% savings)
- **Time:** 4 hours

---

## Implementation Priority

### Critical (Do First)
1. ✅ LLM retry logic (already done)
2. 🔴 LLM request queue
3. 🔴 Parallel processing (5 concurrent)

### High Priority (Do Next)
4. 🟡 HTML caching
5. 🟡 LLM response caching
6. 🟡 Database connection pooling

### Medium Priority (Nice to Have)
7. 🟠 Batch LLM requests
8. 🟠 Streaming Excel export
9. 🟠 Progress monitoring

---

## Testing Plan

### Test 1: LLM Queue (100 firms)
- Verify zero rate limit errors
- Check request rate stays below 50 RPM
- Measure completion time

### Test 2: Parallel Processing (100 firms)
- Test with 1, 3, 5, 10 concurrent workers
- Find optimal concurrency
- Verify no crashes

### Test 3: Caching (100 firms, run twice)
- First run: baseline
- Second run: should be 50-70% faster
- Verify cache hits in logs

### Test 4: Large Scale (1,000 firms)
- Verify system stability
- Check memory usage
- Measure actual throughput

### Test 5: Stress Test (10,000 firms)
- Run overnight
- Monitor for crashes
- Verify data quality

---

## Monitoring & Alerts

### Key Metrics
1. **LLM queue depth** - How many requests waiting
2. **LLM requests/minute** - Current rate
3. **Cache hit rate** - % of requests served from cache
4. **Concurrent workers** - How many active
5. **Throughput** - Firms/minute
6. **Memory usage** - MB used
7. **Database connections** - Active connections

### Alerts
1. **Queue depth > 1000** - System falling behind
2. **Cache hit rate < 30%** - Cache not working
3. **Throughput < 3 firms/min** - Performance issue
4. **Memory > 4 GB** - Memory leak
5. **DB connections > 8** - Connection leak

---

## Next Steps

1. Implement LLM request queue (2-3 hours)
2. Add parallel processing (2-3 hours)
3. Implement caching (2-3 hours)
4. Test with 100-firm file (1 hour)
5. Test with 1,000-firm file (overnight)
6. Deploy and monitor

**Total implementation time: 1-2 days**
**Expected improvement: 7 days → 12 hours (14× faster)**
