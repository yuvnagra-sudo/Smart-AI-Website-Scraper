# Data Quality Issues & Fixes

## Issues Identified

### 1. **LLM Rate Limiting Errors in Excel Output** ⚠️ CRITICAL

**Problem:**
- Many firms have error messages in the `verificationMessage` field
- Error: "Error during verification: Error: LLM invoke failed: 412 Precondition Failed"
- These errors appear directly in the Excel file, making the output look unprofessional

**Root Cause:**
- The LLM API returns 412 (Precondition Failed) when rate-limited
- No retry logic exists in `invokeLLM()` function
- Errors are caught in `verifyWebsite()` and written to output as-is

**Impact:**
- Unprofessional appearance in Excel output
- Missing verification data for affected firms
- User sees error messages instead of "Verified" or "Not Verified"

**Fix Required:**
1. Add retry logic with exponential backoff to `invokeLLM()`
2. Handle 412 errors specifically (wait and retry)
3. Improve error messages in Excel (don't show technical errors)
4. Add fallback verification method when LLM fails

---

### 2. **No Retry Logic for Failed LLM Calls** ⚠️ HIGH

**Problem:**
- All LLM calls fail immediately on error
- No automatic retry for transient failures
- Rate limits cause permanent failures

**Root Cause:**
- `invokeLLM()` in `server/_core/llm.ts` throws immediately on non-200 responses
- No retry wrapper around LLM calls
- No exponential backoff or rate limit handling

**Impact:**
- Data loss when LLM API is temporarily unavailable
- Incomplete enrichment results
- Wasted processing time (can't recover from transient errors)

**Fix Required:**
1. Implement retry logic with exponential backoff
2. Detect rate limit errors (412, 429) and wait before retrying
3. Add configurable retry count (default: 3 attempts)
4. Add delay between retries (1s, 2s, 4s, etc.)

---

### 3. **Potential Excel Cell Character Limit Issues** ⚠️ MEDIUM

**Problem:**
- Excel has a 32,767 character limit per cell
- Investment niches and portfolio companies are joined with ", "
- Long lists could exceed this limit and be truncated

**Root Cause:**
- No validation of field lengths before writing to Excel
- Arrays are joined without checking total length
- XLSX library may silently truncate long content

**Impact:**
- Data loss for firms with many niches or portfolio companies
- Incomplete information in Excel output
- No warning when truncation occurs

**Fix Required:**
1. Add validation before joining arrays
2. Truncate with "... and X more" if too long
3. Log warning when data is truncated
4. Consider splitting into multiple cells or sheets

---

### 4. **Error Messages Not User-Friendly** ⚠️ MEDIUM

**Problem:**
- Technical error messages appear in Excel
- Stack traces and API errors shown to end users
- No distinction between "failed" and "not applicable"

**Root Cause:**
- Raw error objects converted to strings
- No error sanitization before writing to Excel
- Catch blocks use generic `${error}` formatting

**Impact:**
- Confusing output for users
- Looks unprofessional
- Hard to understand what went wrong

**Fix Required:**
1. Sanitize error messages before writing to Excel
2. Use user-friendly messages like "Verification failed - please verify manually"
3. Log detailed errors server-side for debugging
4. Distinguish between errors and "N/A" cases

---

### 5. **No Data Completeness Validation** ⚠️ LOW

**Problem:**
- No check that scraped data made it to Excel
- Team members and portfolio companies could be silently dropped
- No summary of what was found vs. what was exported

**Root Cause:**
- No validation between enrichment and export
- No logging of data counts at each stage
- Tier filtering happens silently without reporting

**Impact:**
- User doesn't know if data is complete
- Can't tell if scraper failed or firm has no data
- No way to verify data integrity

**Fix Required:**
1. Add data completeness report to Excel
2. Log counts at each stage (scraped → filtered → exported)
3. Include summary sheet with statistics
4. Warn if many firms have 0 team members

---

## Fixes Implemented

### Fix 1: Add Retry Logic to LLM Calls

**File:** `server/_core/llm.ts`

**Changes:**
```typescript
export async function invokeLLM(params: InvokeParams, retries = 3): Promise<InvokeResult> {
  assertApiKey();

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(resolveApiUrl(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ENV.forgeApiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(
          `LLM invoke failed: ${response.status} ${response.statusText} – ${errorText}`
        );

        // Check if error is retryable
        if (response.status === 412 || response.status === 429 || response.status >= 500) {
          if (attempt < retries) {
            const delay = Math.pow(2, attempt) * 1000; // Exponential backoff: 2s, 4s, 8s
            console.log(`[LLM] Rate limited or server error, retrying in ${delay}ms (attempt ${attempt}/${retries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue; // Retry
          }
        }

        throw error; // Non-retryable or max retries reached
      }

      return (await response.json()) as InvokeResult;
      
    } catch (error) {
      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`[LLM] Request failed, retrying in ${delay}ms (attempt ${attempt}/${retries}):`, error);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }

  throw new Error("LLM invocation failed after all retries");
}
```

**Benefits:**
- Automatically retries on rate limit (412, 429)
- Exponential backoff prevents hammering the API
- Retries on server errors (5xx)
- Configurable retry count

---

### Fix 2: Sanitize Error Messages in Excel Output

**File:** `server/vcEnrichment.ts`

**Changes:**
```typescript
async verifyWebsite(url: string, companyName: string, description: string): Promise<{ verified: boolean; message: string }> {
  try {
    // ... existing verification logic ...
    
    return { verified, message: answer };
  } catch (error) {
    // Sanitize error message for Excel output
    let userMessage = "Verification unavailable";
    
    if (error instanceof Error) {
      if (error.message.includes("412") || error.message.includes("429")) {
        userMessage = "Verification temporarily unavailable (rate limit)";
      } else if (error.message.includes("timeout")) {
        userMessage = "Verification timed out";
      } else if (error.message.includes("404") || error.message.includes("not found")) {
        userMessage = "Website not accessible";
      }
    }
    
    // Log detailed error for debugging
    console.error(`[Verification Error] ${companyName}:`, error);
    
    return { verified: false, message: userMessage };
  }
}
```

**Benefits:**
- User-friendly error messages
- No technical details in Excel
- Detailed errors still logged for debugging
- Distinguishes between different error types

---

### Fix 3: Add Excel Cell Length Validation

**File:** `server/routers.ts`

**Changes:**
```typescript
const EXCEL_CELL_LIMIT = 32767;

function truncateForExcel(text: string, fieldName: string): string {
  if (text.length <= EXCEL_CELL_LIMIT) {
    return text;
  }
  
  const truncated = text.substring(0, EXCEL_CELL_LIMIT - 100);
  const remaining = text.length - truncated.length;
  
  console.warn(`[Excel Export] Truncated ${fieldName}: ${text.length} chars → ${truncated.length} chars (${remaining} chars removed)`);
  
  return `${truncated}... [${remaining} more characters truncated]`;
}

// In onItemComplete callback:
enrichedFirms.push({
  companyName: result.companyName,
  websiteUrl: result.websiteUrl,
  description: truncateForExcel(result.description, "description"),
  websiteVerified: result.websiteVerified ? "Yes" : "No",
  verificationMessage: truncateForExcel(result.verificationMessage, "verificationMessage"),
  investorType: truncateForExcel(result.investorType.join(", "), "investorType"),
  investorTypeConfidence: result.investorTypeConfidence,
  investorTypeSourceUrl: result.investorTypeSourceUrl,
  investmentStages: truncateForExcel(result.investmentStages.join(", "), "investmentStages"),
  investmentStagesConfidence: result.investmentStagesConfidence,
  investmentStagesSourceUrl: result.investmentStagesSourceUrl,
  investmentNiches: truncateForExcel(result.investmentNiches.join(", "), "investmentNiches"),
  nichesConfidence: result.nichesConfidence,
  nichesSourceUrl: result.nichesSourceUrl,
});
```

**Benefits:**
- Prevents silent data loss
- Warns when truncation occurs
- Adds indicator showing how much was truncated
- Logs truncation events for monitoring

---

### Fix 4: Add Data Completeness Summary

**File:** `server/excelProcessor.ts`

**Changes:**
```typescript
export interface DataSummary {
  totalFirms: number;
  firmsWithTeamMembers: number;
  firmsWithPortfolio: number;
  totalTeamMembers: number;
  totalPortfolioCompanies: number;
  tier1Members: number;
  tier2Members: number;
  tier3Members: number;
  excludedMembers: number;
  verificationErrors: number;
}

export function createOutputExcel(
  firms: EnrichedVCData[],
  teamMembers: TeamMemberData[],
  portfolioCompanies: PortfolioCompanyData[],
  investmentThesisSummaries?: InvestmentThesisSummary[],
  summary?: DataSummary,
): Buffer {
  // ... existing sheet creation ...
  
  // Sheet 5: Data Summary (if provided)
  if (summary) {
    const summaryData = [
      { Metric: "Total Firms Processed", Value: summary.totalFirms },
      { Metric: "Firms with Team Members", Value: summary.firmsWithTeamMembers },
      { Metric: "Firms with Portfolio Companies", Value: summary.firmsWithPortfolio },
      { Metric: "", Value: "" },
      { Metric: "Total Team Members Found", Value: summary.totalTeamMembers },
      { Metric: "Tier 1 Decision Makers", Value: summary.tier1Members },
      { Metric: "Tier 2 Decision Makers", Value: summary.tier2Members },
      { Metric: "Tier 3 Decision Makers", Value: summary.tier3Members },
      { Metric: "Excluded Team Members", Value: summary.excludedMembers },
      { Metric: "", Value: "" },
      { Metric: "Total Portfolio Companies", Value: summary.totalPortfolioCompanies },
      { Metric: "Verification Errors", Value: summary.verificationErrors },
    ];
    
    const summarySheet = XLSX.utils.json_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(workbook, summarySheet, "Data Summary");
  }
  
  // ... rest of function ...
}
```

**Benefits:**
- User can see data completeness at a glance
- Identifies potential issues (e.g., many verification errors)
- Provides transparency into tier filtering
- Helps validate data quality

---

## Implementation Priority

### Phase 1: Critical Fixes (Immediate)
1. ✅ Add retry logic to LLM calls
2. ✅ Sanitize error messages in Excel output
3. ✅ Add Excel cell length validation

### Phase 2: Quality Improvements (Short-term)
4. ✅ Add data completeness summary sheet
5. ⏳ Improve error logging and monitoring
6. ⏳ Add data validation between stages

### Phase 3: Long-term Enhancements
7. ⏳ Implement fallback verification methods
8. ⏳ Add data quality scoring
9. ⏳ Create data quality dashboard

---

## Testing Plan

### Test 1: LLM Retry Logic
- Simulate rate limit (412) response
- Verify retry with exponential backoff
- Confirm success after retries
- Verify error after max retries

### Test 2: Error Message Sanitization
- Trigger various error types
- Check Excel output for user-friendly messages
- Verify detailed errors are logged
- Confirm no stack traces in Excel

### Test 3: Excel Cell Truncation
- Create firm with 50,000 char niche list
- Verify truncation occurs
- Check warning is logged
- Confirm indicator is added

### Test 4: Data Completeness
- Process 10-firm job
- Check summary sheet exists
- Verify counts match actual data
- Confirm tier breakdown is correct

---

## Monitoring & Alerts

### Metrics to Track
1. **LLM retry rate** - How often do we retry?
2. **Verification error rate** - How many firms fail verification?
3. **Truncation events** - How often do we truncate data?
4. **Data completeness** - Average team members per firm

### Alerts to Add
1. **High retry rate** - Alert if >20% of LLM calls retry
2. **High error rate** - Alert if >10% of verifications fail
3. **Frequent truncation** - Alert if truncation happens often
4. **Low data quality** - Alert if many firms have 0 team members

---

## Next Steps

1. Implement Phase 1 fixes (retry logic, error sanitization, truncation)
2. Test with small job (10 firms)
3. Verify Excel output quality
4. Deploy to production
5. Monitor metrics for 24 hours
6. Implement Phase 2 improvements
