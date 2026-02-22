# Data Pipeline Comprehensive Audit

## Objective
Find all instances where fields are defined in one part of the pipeline but not flowing through to the final output.

## Areas to Audit

### 1. Team Member Data Flow
- [ ] ExtractedTeamMember interface (llmPageAnalyzer.ts)
- [ ] TeamMember interface (vcEnrichment.ts)
- [ ] TeamMemberData interface (excelProcessor.ts)
- [ ] teamMembers schema (drizzle/schema.ts)
- [ ] Team member insert (routers.ts)
- [ ] Excel columns (generateResultsService.ts, generateResults.ts)

### 2. Firm Data Flow
- [ ] ExtractedFirmData interface (llmPageAnalyzer.ts)
- [ ] Firm enrichment result (vcEnrichment.ts)
- [ ] enrichedFirms schema (drizzle/schema.ts)
- [ ] Firm insert (routers.ts)
- [ ] Excel columns (generateResultsService.ts, generateResults.ts)

### 3. Portfolio Company Data Flow
- [ ] ExtractedPortfolioCompany interface (llmPageAnalyzer.ts)
- [ ] Portfolio company result (vcEnrichment.ts)
- [ ] portfolioCompanies schema (drizzle/schema.ts)
- [ ] Portfolio insert (routers.ts)
- [ ] Excel columns (generateResultsService.ts, generateResults.ts)

## Audit Checklist

For each field:
1. ✅ Defined in extraction interface?
2. ✅ In LLM prompt instructions?
3. ✅ In LLM JSON schema?
4. ✅ In LLM response parsing?
5. ✅ In intermediate interface (vcEnrichment)?
6. ✅ In database schema?
7. ✅ In database insert?
8. ✅ In Excel interface?
9. ✅ In Excel column definition?
10. ✅ In Excel row data mapping?

## Known Issues Found

### Issue #1: analyzeProfilePageWithLLM missing individual mandate fields
- **Status:** ✅ FIXED
- **Impact:** 100% of individual mandate data was empty
- **Fields affected:** investmentFocus, stagePreference, checkSizeRange, geographicFocus, investmentThesis, notableInvestments, yearsExperience, background

### Issue #2: TBD
