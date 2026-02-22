# Scalability Architecture for Large Datasets

## Current Limitations

### File Upload/Download Limits
**Current implementation:**
- No explicit file size limits
- Entire file loaded into memory
- Single Excel file output (all data in one file)

**Problems with 20,000 firms:**
- **Memory**: 20K firms × 10 team members × 5 portfolio companies = 1M+ rows
- **Excel limit**: Excel 2016+ supports 1,048,576 rows, but performance degrades after 100K rows
- **Download size**: Could exceed 100MB, causing browser timeouts
- **Processing time**: 20K firms × 9 seconds = 50 hours of processing

### Current Architecture Issues
```
User uploads Excel (20K rows)
  ↓
Load entire file into memory (200MB+)
  ↓
Process all firms sequentially/in batches
  ↓
Store all results in memory
  ↓
Generate single Excel file (500MB+)
  ↓
Upload to S3
  ↓
User downloads (timeout risk)
```

## Recommended Architecture for Scale

### Phase 1: Database-Backed Storage (Immediate)

**Store enriched data in database instead of Excel:**

```typescript
// New schema tables
enrichedFirms (id, jobId, companyName, websiteUrl, ...)
enrichedTeamMembers (id, firmId, name, title, linkedinUrl, ...)
enrichedPortfolioCompanies (id, firmId, companyName, investmentDate, ...)
```

**Benefits:**
- No memory limits
- Incremental processing (save as you go)
- Resume interrupted jobs
- Query and filter before export
- Multiple export formats

**Implementation:**
1. Update `drizzle/schema.ts` with new tables
2. Save each enriched firm to database immediately after processing
3. Generate Excel on-demand from database query
4. Add pagination to exports (max 1000 firms per file)

### Phase 2: Chunked Processing & Export (Week 2)

**Split large jobs into manageable chunks:**

```typescript
// Process in chunks of 100 firms
for (let i = 0; i < firms.length; i += 100) {
  const chunk = firms.slice(i, i + 100);
  await processChunk(chunk);
  await saveToDatabase(chunk);
  
  // Update progress: "Processed 500/20000 firms (2.5%)"
  await updateJobProgress(jobId, i + chunk.length, firms.length);
}
```

**Export in multiple files:**
```
vc_enrichment_part1_firms_1-1000.xlsx
vc_enrichment_part2_firms_1001-2000.xlsx
...
vc_enrichment_part20_firms_19001-20000.xlsx
```

Or provide CSV export for unlimited rows:
```
vc_enrichment_firms.csv (all 20K firms)
vc_enrichment_team_members.csv (all contacts)
vc_enrichment_portfolio.csv (all portfolio companies)
```

### Phase 3: Streaming & Background Jobs (Week 3-4)

**Stream processing:**
- Don't load entire file into memory
- Process row-by-row
- Write results incrementally

**Background job queue:**
```typescript
// Use a job queue (Bull, BullMQ, or simple database queue)
interface EnrichmentJob {
  id: string;
  userId: string;
  status: "queued" | "processing" | "completed" | "failed";
  totalFirms: number;
  processedFirms: number;
  startedAt: Date;
  estimatedCompletionAt: Date;
}
```

**Benefits:**
- User doesn't wait for 50 hours
- Can close browser and come back later
- Email notification when complete
- Resume if server restarts

## File Size Limits & Recommendations

### Upload Limits

**Recommended limits:**
```typescript
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_FIRMS_PER_JOB = 10000; // Limit to 10K firms per job
```

**For 20K firms:**
- Split into 2 separate jobs (10K each)
- OR process in single job but export in chunks

### Download Limits

**Single Excel file limits:**
- **Soft limit**: 10MB (fast download, good Excel performance)
- **Hard limit**: 50MB (slow but manageable)
- **Beyond 50MB**: Use CSV or split into multiple files

**Recommendations for 20K firms:**
1. **Option A**: Multiple Excel files (1000 firms each = 20 files)
2. **Option B**: Single CSV file (unlimited rows, smaller size)
3. **Option C**: Database export with web UI for filtering/searching

## Memory Optimization

### Current Memory Usage (Estimated)

**For 20K firms:**
```
Input Excel: ~20MB
Loaded in memory: ~200MB (parsed objects)
Enrichment results: ~500MB (with all team members & portfolio)
Output Excel: ~100MB
Peak memory: ~800MB
```

**Node.js default heap limit: 4GB**
- Safe for up to ~50K firms
- Beyond that, need streaming

### Optimizations

**1. Stream Excel parsing:**
```typescript
import { Readable } from "stream";
import * as XLSX from "xlsx";

async function* streamExcelRows(fileUrl: string) {
  const response = await axios.get(fileUrl, { responseType: "stream" });
  const stream = response.data as Readable;
  
  // Use xlsx-stream or similar for row-by-row parsing
  for await (const row of parseExcelStream(stream)) {
    yield row;
  }
}
```

**2. Process and discard:**
```typescript
for await (const firm of streamExcelRows(fileUrl)) {
  const enriched = await enrichFirm(firm);
  await saveToDatabase(enriched); // Save immediately
  // Don't keep in memory
}
```

**3. Paginated export:**
```typescript
// Generate Excel from database in pages
async function exportPage(jobId: string, page: number, pageSize: number) {
  const offset = page * pageSize;
  const firms = await db.select()
    .from(enrichedFirms)
    .where(eq(enrichedFirms.jobId, jobId))
    .limit(pageSize)
    .offset(offset);
  
  return createExcelFromFirms(firms);
}
```

## Implementation Roadmap

### Week 1: Database Storage
- [ ] Add enriched data tables to schema
- [ ] Update enrichment logic to save to database
- [ ] Add export endpoint with pagination
- [ ] Test with 1000 firms

### Week 2: Chunked Processing
- [ ] Implement chunk-based processing (100 firms/chunk)
- [ ] Add progress tracking UI
- [ ] Implement multi-file export
- [ ] Test with 5000 firms

### Week 3: Streaming & Background Jobs
- [ ] Implement streaming Excel parser
- [ ] Add job queue system
- [ ] Add email notifications
- [ ] Test with 20000 firms

### Week 4: Advanced Features
- [ ] Add CSV export option
- [ ] Implement resume/retry for failed jobs
- [ ] Add data filtering before export
- [ ] Performance optimization

## Cost Implications

### Current Costs (20K firms)
- **API calls**: ~$75-100 (as estimated)
- **Storage**: Negligible (S3 is cheap)
- **Processing time**: ~50 hours

### With Database Storage
- **Additional database storage**: ~500MB for 20K firms
- **TiDB/MySQL cost**: Included in Manus platform
- **S3 storage**: $0.023/GB/month × 0.5GB = $0.01/month
- **Total additional cost**: ~$0 (database included)

### With Background Jobs
- **Server uptime**: Need to keep server running
- **Manus platform**: Already running 24/7
- **No additional cost**

## Recommended Immediate Actions

### 1. Add File Size Validation (Today)
```typescript
// In upload endpoint
if (fileSize > MAX_UPLOAD_SIZE) {
  throw new Error(`File too large. Maximum size: ${MAX_UPLOAD_SIZE / 1024 / 1024}MB`);
}

if (firmCount > MAX_FIRMS_PER_JOB) {
  throw new Error(`Too many firms. Maximum: ${MAX_FIRMS_PER_JOB} firms per job`);
}
```

### 2. Add Database Storage (This Week)
- Store enriched data in database
- Keep Excel export for compatibility
- Add "Export to CSV" option

### 3. Add Progress Tracking (This Week)
- Show real-time progress: "Processing firm 523/20000 (2.6%)"
- Estimate time remaining
- Allow user to close browser and check back later

### 4. Plan for Scale (Next Week)
- Implement chunked processing
- Add multi-file export
- Test with 10K firms

## Alternative: Use Existing Tools

### If building this is too complex:

**Option A: Use Airtable**
- Import CSV with 20K firms
- Use Airtable API to enrich
- Export results
- **Limit**: 50K records on Pro plan

**Option B: Use Google Sheets**
- 10M cells limit (enough for 20K firms)
- Use Google Apps Script for enrichment
- Slower but more accessible

**Option C: Desktop Application**
- Build Electron app
- No server limits
- Process locally
- Export to Excel/CSV

## Questions to Consider

1. **How often will you process 20K firms?**
   - If once: Current architecture might be okay with some tweaks
   - If regularly: Need database storage

2. **Do you need all data at once?**
   - If yes: Multi-file export
   - If no: Web UI with search/filter

3. **What's your timeline?**
   - If urgent: Add file limits and chunking
   - If flexible: Build proper architecture

4. **Budget for infrastructure?**
   - If limited: Use current Manus platform (included)
   - If flexible: Consider dedicated server for processing
