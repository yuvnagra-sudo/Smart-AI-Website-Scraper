/**
 * Incremental Save Module
 * Saves each firm's data immediately after processing to prevent data loss on crashes
 */

import { getDb } from "./db";
import { enrichedFirms, teamMembers, portfolioCompanies, processedFirms } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { classifyDecisionMakerTier } from './decisionMakerTiers';
import { calculateRecencyScore } from './portfolioIntelligence';
import type { EnrichmentResult } from "./vcEnrichment";

/**
 * Save a single firm's enrichment results immediately to the database
 * Returns the firm ID for reference
 */
export async function saveFirmImmediately(
  jobId: number,
  result: EnrichmentResult,
  tierFilter: string = "all"
): Promise<number | null> {
  const db = await getDb();
  if (!db) {
    console.error(`[incrementalSave] Database connection failed`);
    return null;
  }

  try {
    // Mark firm as processing in processedFirms table
    await db.insert(processedFirms).values({
      jobId,
      firmName: result.companyName,
      firmUrl: result.websiteUrl,
      status: "processing",
      teamMembersFound: result.teamMembers.length,
    });

    // Check if firm already exists in database
    const existing = await db.select({ id: enrichedFirms.id })
      .from(enrichedFirms)
      .where(and(
        eq(enrichedFirms.jobId, jobId),
        eq(enrichedFirms.companyName, result.companyName)
      ))
      .limit(1);

    let firmId: number;

    if (existing.length > 0) {
      console.log(`[incrementalSave] ⚠️  Firm "${result.companyName}" already exists in database (ID: ${existing[0].id}), skipping insert`);
      firmId = existing[0].id;
    } else {
      // Insert firm
      await db.insert(enrichedFirms).values({
        jobId,
        companyName: result.companyName,
        websiteUrl: result.websiteUrl || null,
        description: result.description || null,
        websiteVerified: result.websiteVerified ? "Yes" : "No",
        verificationMessage: result.verificationMessage || null,
        investorType: result.investorType.join(", ") || null,
        investorTypeConfidence: typeof result.investorTypeConfidence === 'string' 
          ? (result.investorTypeConfidence === 'High' ? 90 : result.investorTypeConfidence === 'Medium' ? 60 : 30)
          : null,
        investorTypeSourceUrl: result.investorTypeSourceUrl || null,
        investmentStages: result.investmentStages.join(", ") || null,
        investmentStagesConfidence: typeof result.investmentStagesConfidence === 'string'
          ? (result.investmentStagesConfidence === 'High' ? 90 : result.investmentStagesConfidence === 'Medium' ? 60 : 30)
          : null,
        investmentStagesSourceUrl: result.investmentStagesSourceUrl || null,
        investmentNiches: result.investmentNiches.join(", ") || null,
        nichesConfidence: typeof result.nichesConfidence === 'string'
          ? (result.nichesConfidence === 'High' ? 90 : result.nichesConfidence === 'Medium' ? 60 : 30)
          : null,
        nichesSourceUrl: result.nichesSourceUrl || null,
        // Structured firm-level investment mandate fields
        investmentThesis: result.firmData?.investmentThesis || null,
        aum: result.firmData?.aum || null,
        sectorFocus: result.firmData?.sectorFocus ? JSON.stringify(result.firmData.sectorFocus) : null,
        geographicFocus: result.firmData?.geographicFocus ? JSON.stringify(result.firmData.geographicFocus) : null,
        foundedYear: result.firmData?.foundedYear || null,
        headquarters: result.firmData?.headquarters || null,
      });

      // Get the inserted firm ID
      const [insertedFirm] = await db.select({ id: enrichedFirms.id })
        .from(enrichedFirms)
        .where(and(
          eq(enrichedFirms.jobId, jobId),
          eq(enrichedFirms.companyName, result.companyName)
        ))
        .orderBy(enrichedFirms.id)
        .limit(1);

      firmId = insertedFirm.id;
      console.log(`[incrementalSave] ✓ Saved firm "${result.companyName}" (ID: ${firmId})`);
    }

    // Save team members with tier filtering
    let savedMemberCount = 0;
    for (const member of result.teamMembers) {
      const tierClassification = classifyDecisionMakerTier(member.title);
      
      // Apply tier filter
      let includeMember = false;
      if (tierFilter === "tier1" && tierClassification.tier === "Tier 1") {
        includeMember = true;
      } else if (tierFilter === "tier1-2" && (tierClassification.tier === "Tier 1" || tierClassification.tier === "Tier 2" || tierClassification.tier === "Tier 3")) {
        includeMember = true;
      } else if (tierFilter === "all") {
        includeMember = true;
      }

      if (includeMember) {
        await db.insert(teamMembers).values({
          jobId,
          firmId,
          vcFirm: result.companyName,
          name: member.name,
          title: member.title || null,
          jobFunction: member.jobFunction || null,
          specialization: member.specialization || null,
          linkedinUrl: member.linkedinUrl || null,
          email: member.email || null,
          portfolioCompanies: member.portfolioCompanies || null,
          investmentFocus: member.investmentFocus || null,
          stagePreference: member.stagePreference || null,
          checkSizeRange: member.checkSizeRange || null,
          geographicFocus: member.geographicFocus || null,
          investmentThesis: member.investmentThesis || null,
          notableInvestments: member.notableInvestments || null,
          yearsExperience: member.yearsExperience || null,
          background: member.background || null,
          dataSourceUrl: member.dataSourceUrl || null,
          confidenceScore: typeof member.confidenceScore === 'number' ? member.confidenceScore : null,
          decisionMakerTier: tierClassification.tier,
          tierPriority: tierClassification.priority,
        });
        savedMemberCount++;
      }
    }
    console.log(`[incrementalSave] ✓ Saved ${savedMemberCount}/${result.teamMembers.length} team members for "${result.companyName}"`);

    // Save portfolio companies
    for (const company of result.portfolioCompanies) {
      const { score, category } = calculateRecencyScore(company.investmentDate);
      
      await db.insert(portfolioCompanies).values({
        jobId,
        firmId,
        vcFirm: result.companyName,
        portfolioCompany: company.companyName,
        investmentDate: company.investmentDate || null,
        websiteUrl: company.websiteUrl || null,
        investmentNiche: company.investmentNiche.join(", ") || null,
        dataSourceUrl: company.dataSourceUrl || null,
        confidenceScore: typeof company.confidenceScore === 'number' ? company.confidenceScore : null,
        recencyScore: score,
        recencyCategory: category,
      });
    }
    console.log(`[incrementalSave] ✓ Saved ${result.portfolioCompanies.length} portfolio companies for "${result.companyName}"`);

    // Mark firm as completed in processedFirms table
    await db.update(processedFirms)
      .set({
        status: "completed",
        completedAt: new Date(),
        teamMembersFound: savedMemberCount,
      })
      .where(and(
        eq(processedFirms.jobId, jobId),
        eq(processedFirms.firmName, result.companyName)
      ));

    return firmId;
  } catch (error) {
    console.error(`[incrementalSave] Error saving firm "${result.companyName}":`, error);
    
    // Mark firm as failed in processedFirms table
    try {
      await db.update(processedFirms)
        .set({
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        .where(and(
          eq(processedFirms.jobId, jobId),
          eq(processedFirms.firmName, result.companyName)
        ));
    } catch (updateError) {
      console.error(`[incrementalSave] Failed to update processedFirms status:`, updateError);
    }
    
    return null;
  }
}

/**
 * Check if a firm has already been processed
 */
export async function isFirmProcessed(jobId: number, firmName: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  const result = await db.select()
    .from(processedFirms)
    .where(and(
      eq(processedFirms.jobId, jobId),
      eq(processedFirms.firmName, firmName),
      eq(processedFirms.status, "completed")
    ))
    .limit(1);

  return result.length > 0;
}

/**
 * Get list of already processed firms for a job
 */
export async function getProcessedFirms(jobId: number): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];

  const result = await db.select({ firmName: processedFirms.firmName })
    .from(processedFirms)
    .where(and(
      eq(processedFirms.jobId, jobId),
      eq(processedFirms.status, "completed")
    ));

  return result.map(r => r.firmName);
}
