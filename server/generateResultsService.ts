/**
 * Generate Results Service
 * On-demand Excel file generation from database
 */

import { getDb } from "./db";
import { enrichmentJobs, enrichedFirms, teamMembers, portfolioCompanies, investmentThesis } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";

interface GenerateResultsOptions {
  jobId: number;
  forceRegenerate?: boolean; // Regenerate even if file already exists
}

interface GenerateResultsResult {
  success: boolean;
  fileBuffer: Buffer;
  fileName: string;
  firmCount: number;
  teamMemberCount: number;
}

/**
 * Generate Excel results file for a completed job
 * Matches the original format with 5 sheets:
 * 1. VC Firms (14 columns)
 * 2. Team Members (10 columns)
 * 3. Portfolio Companies (9 columns)
 * 4. Investment Thesis (15 columns)
 * 5. Processing Summary (10 columns)
 */
export async function generateResultsFile(
  options: GenerateResultsOptions
): Promise<GenerateResultsResult> {
  const { jobId, forceRegenerate = false } = options;

  console.log(`[generateResults] Starting for job ${jobId}`);

  const db = await getDb();
  if (!db) {
    throw new Error("Database connection failed");
  }

  // Get job details
  const jobResults = await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.id, jobId)).limit(1);
  const job = jobResults[0];

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  console.log(`[generateResults] Job status: ${job.status}, Processed: ${job.processedCount}/${job.firmCount}`);

  // Get all data for this job
  const firms = await db.select().from(enrichedFirms).where(eq(enrichedFirms.jobId, jobId));
  const allTeamMembers = await db.select().from(teamMembers).where(eq(teamMembers.jobId, jobId));
  const allPortfolioCompanies = await db.select().from(portfolioCompanies).where(eq(portfolioCompanies.jobId, jobId));
  const allInvestmentThesis = await db.select().from(investmentThesis).where(eq(investmentThesis.jobId, jobId));

  console.log(`[generateResults] Found ${firms.length} firms, ${allTeamMembers.length} team members, ${allPortfolioCompanies.length} portfolio companies, ${allInvestmentThesis.length} investment theses`);

  if (firms.length === 0) {
    throw new Error("No enriched firms found for this job");
  }

  // Create Excel workbook
  const workbook = new ExcelJS.Workbook();

  // ===== SHEET 1: VC Firms (14 columns) =====
  const firmsSheet = workbook.addWorksheet("VC Firms");
  firmsSheet.columns = [
    { header: "companyName", key: "companyName", width: 30 },
    { header: "websiteUrl", key: "websiteUrl", width: 40 },
    { header: "description", key: "description", width: 60 },
    { header: "websiteVerified", key: "websiteVerified", width: 15 },
    { header: "verificationMessage", key: "verificationMessage", width: 50 },
    { header: "investorType", key: "investorType", width: 20 },
    { header: "investorTypeConfidence", key: "investorTypeConfidence", width: 25 },
    { header: "investorTypeSourceUrl", key: "investorTypeSourceUrl", width: 40 },
    { header: "investmentStages", key: "investmentStages", width: 40 },
    { header: "investmentStagesConfidence", key: "investmentStagesConfidence", width: 30 },
    { header: "investmentStagesSourceUrl", key: "investmentStagesSourceUrl", width: 40 },
    { header: "investmentNiches", key: "investmentNiches", width: 50 },
    { header: "nichesConfidence", key: "nichesConfidence", width: 20 },
    { header: "nichesSourceUrl", key: "nichesSourceUrl", width: 40 },
    // NEW: Structured firm-level investment mandate fields
    { header: "investmentThesis", key: "investmentThesis", width: 60 },
    { header: "aum", key: "aum", width: 20 },
    { header: "sectorFocus", key: "sectorFocus", width: 50 },
    { header: "geographicFocus", key: "geographicFocus", width: 30 },
    { header: "foundedYear", key: "foundedYear", width: 15 },
    { header: "headquarters", key: "headquarters", width: 30 },
  ];

  firms.forEach((firm: any) => {
    firmsSheet.addRow({
      companyName: firm.companyName,
      websiteUrl: firm.websiteUrl,
      description: firm.description,
      websiteVerified: firm.websiteVerified,
      verificationMessage: firm.verificationMessage,
      investorType: firm.investorType,
      investorTypeConfidence: firm.investorTypeConfidence,
      investorTypeSourceUrl: firm.investorTypeSourceUrl,
      investmentStages: firm.investmentStages,
      investmentStagesConfidence: firm.investmentStagesConfidence,
      investmentStagesSourceUrl: firm.investmentStagesSourceUrl,
      investmentNiches: firm.investmentNiches,
      nichesConfidence: firm.nichesConfidence,
      nichesSourceUrl: firm.nichesSourceUrl,
      // NEW: Structured firm-level investment mandate fields
      investmentThesis: firm.investmentThesis,
      aum: firm.aum,
      sectorFocus: firm.sectorFocus,
      geographicFocus: firm.geographicFocus,
      foundedYear: firm.foundedYear,
      headquarters: firm.headquarters,
    });
  });

  // ===== SHEET 2: Team Members (20 columns) =====
  const membersSheet = workbook.addWorksheet("Team Members");
  membersSheet.columns = [
    { header: "vcFirm", key: "vcFirm", width: 30 },
    { header: "name", key: "name", width: 30 },
    { header: "title", key: "title", width: 30 },
    { header: "jobFunction", key: "jobFunction", width: 30 },
    { header: "specialization", key: "specialization", width: 40 },
    { header: "linkedinUrl", key: "linkedinUrl", width: 40 },
    { header: "email", key: "email", width: 35 },
    { header: "portfolioCompanies", key: "portfolioCompanies", width: 50 },
    // Individual investment mandate columns
    { header: "investmentFocus", key: "investmentFocus", width: 40 },
    { header: "stagePreference", key: "stagePreference", width: 30 },
    { header: "checkSizeRange", key: "checkSizeRange", width: 25 },
    { header: "geographicFocus", key: "geographicFocus", width: 30 },
    { header: "investmentThesis", key: "investmentThesis", width: 60 },
    { header: "notableInvestments", key: "notableInvestments", width: 50 },
    { header: "yearsExperience", key: "yearsExperience", width: 20 },
    { header: "background", key: "background", width: 50 },
    { header: "dataSourceUrl", key: "dataSourceUrl", width: 40 },
    { header: "confidenceScore", key: "confidenceScore", width: 20 },
    { header: "decisionMakerTier", key: "decisionMakerTier", width: 20 },
    { header: "tierPriority", key: "tierPriority", width: 15 },
  ];

  allTeamMembers.forEach((member: any) => {
    membersSheet.addRow({
      vcFirm: member.vcFirm,
      name: member.name,
      title: member.title,
      jobFunction: member.jobFunction,
      specialization: member.specialization,
      linkedinUrl: member.linkedinUrl,
      email: member.email || "",
      portfolioCompanies: member.portfolioCompanies || "",
      investmentFocus: member.investmentFocus || "",
      stagePreference: member.stagePreference || "",
      checkSizeRange: member.checkSizeRange || "",
      geographicFocus: member.geographicFocus || "",
      investmentThesis: member.investmentThesis || "",
      notableInvestments: member.notableInvestments || "",
      yearsExperience: member.yearsExperience || "",
      background: member.background || "",
      dataSourceUrl: member.dataSourceUrl,
      confidenceScore: member.confidenceScore,
      decisionMakerTier: member.decisionMakerTier,
      tierPriority: member.tierPriority,
    });
  });

  // ===== SHEET 3: Portfolio Companies (9 columns) =====
  const portfolioSheet = workbook.addWorksheet("Portfolio Companies");
  portfolioSheet.columns = [
    { header: "vcFirm", key: "vcFirm", width: 30 },
    { header: "portfolioCompany", key: "portfolioCompany", width: 30 },
    { header: "investmentDate", key: "investmentDate", width: 20 },
    { header: "websiteUrl", key: "websiteUrl", width: 40 },
    { header: "investmentNiche", key: "investmentNiche", width: 40 },
    { header: "dataSourceUrl", key: "dataSourceUrl", width: 40 },
    { header: "confidenceScore", key: "confidenceScore", width: 20 },
    { header: "recencyScore", key: "recencyScore", width: 15 },
    { header: "recencyCategory", key: "recencyCategory", width: 20 },
  ];

  allPortfolioCompanies.forEach((company: any) => {
    portfolioSheet.addRow({
      vcFirm: company.vcFirm,
      portfolioCompany: company.portfolioCompany,
      investmentDate: company.investmentDate,
      websiteUrl: company.websiteUrl,
      investmentNiche: company.investmentNiche,
      dataSourceUrl: company.dataSourceUrl,
      confidenceScore: company.confidenceScore,
      recencyScore: company.recencyScore,
      recencyCategory: company.recencyCategory,
    });
  });

  // ===== SHEET 4: Investment Thesis (15 columns) =====
  const thesisSheet = workbook.addWorksheet("Investment Thesis");
  thesisSheet.columns = [
    { header: "vcFirm", key: "vcFirm", width: 30 },
    { header: "websiteUrl", key: "websiteUrl", width: 40 },
    { header: "investorType", key: "investorType", width: 20 },
    { header: "primaryFocusAreas", key: "primaryFocusAreas", width: 50 },
    { header: "emergingInterests", key: "emergingInterests", width: 50 },
    { header: "preferredStages", key: "preferredStages", width: 40 },
    { header: "averageCheckSize", key: "averageCheckSize", width: 20 },
    { header: "recentInvestmentPace", key: "recentInvestmentPace", width: 25 },
    { header: "keyDecisionMakers", key: "keyDecisionMakers", width: 40 },
    { header: "totalTeamSize", key: "totalTeamSize", width: 15 },
    { header: "tier1Count", key: "tier1Count", width: 15 },
    { header: "tier2Count", key: "tier2Count", width: 15 },
    { header: "portfolioSize", key: "portfolioSize", width: 15 },
    { header: "recentPortfolioCount", key: "recentPortfolioCount", width: 20 },
    { header: "talkingPoints", key: "talkingPoints", width: 60 },
  ];

  allInvestmentThesis.forEach((thesis: any) => {
    thesisSheet.addRow({
      vcFirm: thesis.vcFirm,
      websiteUrl: thesis.websiteUrl,
      investorType: thesis.investorType,
      primaryFocusAreas: thesis.primaryFocusAreas,
      emergingInterests: thesis.emergingInterests,
      preferredStages: thesis.preferredStages,
      averageCheckSize: thesis.averageCheckSize,
      recentInvestmentPace: thesis.recentInvestmentPace,
      keyDecisionMakers: thesis.keyDecisionMakers,
      totalTeamSize: thesis.totalTeamSize,
      tier1Count: thesis.tier1Count,
      tier2Count: thesis.tier2Count,
      portfolioSize: thesis.portfolioSize,
      recentPortfolioCount: thesis.recentPortfolioCount,
      talkingPoints: thesis.talkingPoints,
    });
  });

  // ===== SHEET 5: Processing Summary (10 columns) =====
  const summarySheet = workbook.addWorksheet("Processing Summary");
  summarySheet.columns = [
    { header: "firmName", key: "firmName", width: 30 },
    { header: "website", key: "website", width: 40 },
    { header: "status", key: "status", width: 15 },
    { header: "errorMessage", key: "errorMessage", width: 50 },
    { header: "teamMembersFound", key: "teamMembersFound", width: 20 },
    { header: "tier1Count", key: "tier1Count", width: 15 },
    { header: "tier2Count", key: "tier2Count", width: 15 },
    { header: "tier3Count", key: "tier3Count", width: 15 },
    { header: "portfolioCompaniesFound", key: "portfolioCompaniesFound", width: 25 },
    { header: "dataCompleteness", key: "dataCompleteness", width: 30 },
  ];

  firms.forEach((firm: any) => {
    const firmTeamMembers = allTeamMembers.filter((m: any) => m.firmId === firm.id);
    const firmPortfolio = allPortfolioCompanies.filter((p: any) => p.firmId === firm.id);
    const tier1Count = firmTeamMembers.filter((m: any) => m.decisionMakerTier === "Tier 1").length;
    const tier2Count = firmTeamMembers.filter((m: any) => m.decisionMakerTier === "Tier 2").length;
    const tier3Count = firmTeamMembers.filter((m: any) => m.decisionMakerTier === "Tier 3").length;

    // Determine status and error message
    let status = "Success";
    let errorMessage = "";
    let dataCompleteness = "Complete";

    if (firm.websiteVerified === "No") {
      status = "Warning";
      errorMessage = firm.verificationMessage || "Website verification failed";
      dataCompleteness = "Partial - Website not accessible";
    } else if (firmTeamMembers.length === 0 && firmPortfolio.length === 0) {
      status = "Warning";
      errorMessage = "No team members or portfolio companies found";
      dataCompleteness = "Minimal";
    } else if (firmTeamMembers.length === 0) {
      status = "Warning";
      errorMessage = "No team members found";
      dataCompleteness = "Partial - Missing team data";
    } else if (firmPortfolio.length === 0) {
      status = "Warning";
      errorMessage = "No portfolio companies found";
      dataCompleteness = "Partial - Missing portfolio data";
    }

    summarySheet.addRow({
      firmName: firm.companyName,
      website: firm.websiteUrl,
      status,
      errorMessage,
      teamMembersFound: firmTeamMembers.length,
      tier1Count,
      tier2Count,
      tier3Count,
      portfolioCompaniesFound: firmPortfolio.length,
      dataCompleteness,
    });
  });

  // ===== SHEET 6: Extraction Metrics (per-firm data quality) =====
  const metricsSheet = workbook.addWorksheet("Extraction Metrics");
  metricsSheet.columns = [
    { header: "firmName", key: "firmName", width: 30 },
    { header: "teamMembersFound", key: "teamMembersFound", width: 20 },
    { header: "linkedInCoverage", key: "linkedInCoverage", width: 20 },
    { header: "emailCoverage", key: "emailCoverage", width: 20 },
    { header: "specializationCoverage", key: "specializationCoverage", width: 25 },
    { header: "tier1Percent", key: "tier1Percent", width: 15 },
    { header: "tier2Percent", key: "tier2Percent", width: 15 },
    { header: "tier3Percent", key: "tier3Percent", width: 15 },
    { header: "portfolioCompanies", key: "portfolioCompanies", width: 20 },
    { header: "dataQualityScore", key: "dataQualityScore", width: 20 },
    { header: "extractionNotes", key: "extractionNotes", width: 50 },
  ];

  // Calculate overall job metrics
  let totalLinkedIn = 0;
  let totalEmail = 0;
  let totalSpecialization = 0;
  let totalTier1 = 0;
  let totalTier2 = 0;
  let totalTier3 = 0;

  firms.forEach((firm: any) => {
    const firmTeamMembers = allTeamMembers.filter((m: any) => m.firmId === firm.id);
    const firmPortfolio = allPortfolioCompanies.filter((p: any) => p.firmId === firm.id);
    
    const teamCount = firmTeamMembers.length;
    const linkedInCount = firmTeamMembers.filter((m: any) => m.linkedinUrl && m.linkedinUrl.length > 0).length;
    const emailCount = firmTeamMembers.filter((m: any) => m.email && m.email.length > 0).length;
    const specializationCount = firmTeamMembers.filter((m: any) => m.specialization && m.specialization.length > 0).length;
    const tier1Count = firmTeamMembers.filter((m: any) => m.decisionMakerTier === "Tier 1").length;
    const tier2Count = firmTeamMembers.filter((m: any) => m.decisionMakerTier === "Tier 2").length;
    const tier3Count = firmTeamMembers.filter((m: any) => m.decisionMakerTier === "Tier 3").length;

    // Update totals
    totalLinkedIn += linkedInCount;
    totalEmail += emailCount;
    totalSpecialization += specializationCount;
    totalTier1 += tier1Count;
    totalTier2 += tier2Count;
    totalTier3 += tier3Count;

    // Calculate percentages
    const linkedInPct = teamCount > 0 ? Math.round((linkedInCount / teamCount) * 100) : 0;
    const emailPct = teamCount > 0 ? Math.round((emailCount / teamCount) * 100) : 0;
    const specializationPct = teamCount > 0 ? Math.round((specializationCount / teamCount) * 100) : 0;
    const tier1Pct = teamCount > 0 ? Math.round((tier1Count / teamCount) * 100) : 0;
    const tier2Pct = teamCount > 0 ? Math.round((tier2Count / teamCount) * 100) : 0;
    const tier3Pct = teamCount > 0 ? Math.round((tier3Count / teamCount) * 100) : 0;

    // Calculate data quality score (0-100)
    // Weighted: LinkedIn (30%), Email (20%), Specialization (20%), Team size (30%)
    const teamSizeScore = Math.min(teamCount / 10, 1) * 100; // Max score at 10+ members
    const dataQualityScore = Math.round(
      (linkedInPct * 0.3) + (emailPct * 0.2) + (specializationPct * 0.2) + (teamSizeScore * 0.3)
    );

    // Generate extraction notes
    const notes: string[] = [];
    if (teamCount === 0) notes.push("No team members found");
    else if (teamCount < 3) notes.push("Few team members found");
    if (linkedInPct < 30) notes.push("Low LinkedIn coverage");
    if (emailPct === 0) notes.push("No emails found");
    if (firmPortfolio.length === 0) notes.push("No portfolio companies");
    if (firm.websiteVerified === "No") notes.push("Website not accessible");

    metricsSheet.addRow({
      firmName: firm.companyName,
      teamMembersFound: teamCount,
      linkedInCoverage: `${linkedInPct}%`,
      emailCoverage: `${emailPct}%`,
      specializationCoverage: `${specializationPct}%`,
      tier1Percent: `${tier1Pct}%`,
      tier2Percent: `${tier2Pct}%`,
      tier3Percent: `${tier3Pct}%`,
      portfolioCompanies: firmPortfolio.length,
      dataQualityScore: `${dataQualityScore}/100`,
      extractionNotes: notes.length > 0 ? notes.join("; ") : "Good extraction",
    });
  });

  // Add summary row at the end
  const totalTeam = allTeamMembers.length;
  const overallLinkedInPct = totalTeam > 0 ? Math.round((totalLinkedIn / totalTeam) * 100) : 0;
  const overallEmailPct = totalTeam > 0 ? Math.round((totalEmail / totalTeam) * 100) : 0;
  const overallSpecPct = totalTeam > 0 ? Math.round((totalSpecialization / totalTeam) * 100) : 0;
  const overallTier1Pct = totalTeam > 0 ? Math.round((totalTier1 / totalTeam) * 100) : 0;
  const overallTier2Pct = totalTeam > 0 ? Math.round((totalTier2 / totalTeam) * 100) : 0;
  const overallTier3Pct = totalTeam > 0 ? Math.round((totalTier3 / totalTeam) * 100) : 0;
  const avgTeamSize = firms.length > 0 ? Math.round(totalTeam / firms.length) : 0;

  metricsSheet.addRow({}); // Empty row
  metricsSheet.addRow({
    firmName: "=== OVERALL SUMMARY ===",
    teamMembersFound: totalTeam,
    linkedInCoverage: `${overallLinkedInPct}%`,
    emailCoverage: `${overallEmailPct}%`,
    specializationCoverage: `${overallSpecPct}%`,
    tier1Percent: `${overallTier1Pct}%`,
    tier2Percent: `${overallTier2Pct}%`,
    tier3Percent: `${overallTier3Pct}%`,
    portfolioCompanies: allPortfolioCompanies.length,
    dataQualityScore: `Avg team: ${avgTeamSize}`,
    extractionNotes: `${firms.length} firms processed`,
  });

  // Generate Excel buffer
  console.log(`[generateResults] Generating Excel file...`);
  const buffer = await workbook.xlsx.writeBuffer();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `vc-enrichment-job-${jobId}-${timestamp}.xlsx`;

  console.log(`[generateResults] ✅ File generated: ${fileName}`);
  console.log(`[generateResults] 📊 Results: ${firms.length} firms, ${allTeamMembers.length} team members, ${allPortfolioCompanies.length} portfolio companies`);

  return {
    success: true,
    fileBuffer: buffer as any as Buffer,
    fileName,
    firmCount: firms.length,
    teamMemberCount: allTeamMembers.length,
  };
}
