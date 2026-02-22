/**
 * Generate results Excel file for a completed enrichment job
 * Usage: node --import tsx server/generateResults.ts <jobId>
 */

import { drizzle } from "drizzle-orm/mysql2";
import * as schema from "../drizzle/schema.js";
import { enrichmentJobs, enrichedFirms, teamMembers } from "../drizzle/schema.js";
import { eq } from "drizzle-orm";
import { storagePut } from "./storage.js";
import ExcelJS from "exceljs";

async function main() {
  const jobId = parseInt(process.argv[2]);

  if (!jobId) {
    console.error("Usage: node --import tsx server/generateResults.ts <jobId>");
    process.exit(1);
  }

  console.log(`Generating results for job ${jobId}...`);

  // Get job details
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }

  const db = drizzle(process.env.DATABASE_URL, { schema, mode: "default" });

  const job = await db.query.enrichmentJobs.findFirst({
    where: eq(enrichmentJobs.id, jobId),
  });

  if (!job) {
    console.error(`Job ${jobId} not found`);
    process.exit(1);
  }

  console.log(`Job status: ${job.status}, Processed: ${job.processedCount}/${job.firmCount}`);

  // Get enriched firms
  const firms = await db.select().from(enrichedFirms).where(eq(enrichedFirms.jobId, jobId));
  console.log(`Found ${firms.length} enriched firms`);

  // Get team members
  const members = await db.select().from(teamMembers).where(eq(teamMembers.jobId, jobId));
  console.log(`Found ${members.length} team members`);

  // Create Excel workbook
  const workbook = new ExcelJS.Workbook();

  // Firms sheet
  const firmsSheet = workbook.addWorksheet("Firms");
  firmsSheet.columns = [
    { header: "Firm Name", key: "companyName", width: 30 },
    { header: "Website", key: "websiteUrl", width: 40 },
    { header: "Description", key: "description", width: 60 },
    { header: "Website Verified", key: "websiteVerified", width: 15 },
    { header: "Investor Type", key: "investorType", width: 20 },
    { header: "Investment Stages", key: "investmentStages", width: 30 },
    { header: "Investment Niches", key: "investmentNiches", width: 40 },
    // NEW: Structured firm-level investment mandate fields
    { header: "Investment Thesis", key: "investmentThesis", width: 60 },
    { header: "AUM", key: "aum", width: 20 },
    { header: "Sector Focus", key: "sectorFocus", width: 50 },
    { header: "Geographic Focus", key: "geographicFocus", width: 30 },
    { header: "Founded Year", key: "foundedYear", width: 15 },
    { header: "Headquarters", key: "headquarters", width: 30 },
  ];

  firms.forEach((firm) => {
    firmsSheet.addRow({
      companyName: firm.companyName,
      websiteUrl: firm.websiteUrl,
      description: firm.description,
      websiteVerified: firm.websiteVerified,
      investorType: firm.investorType,
      investmentStages: firm.investmentStages,
      investmentNiches: firm.investmentNiches,
      // NEW: Structured firm-level investment mandate fields
      investmentThesis: firm.investmentThesis,
      aum: firm.aum,
      sectorFocus: firm.sectorFocus,
      geographicFocus: firm.geographicFocus,
      foundedYear: firm.foundedYear,
      headquarters: firm.headquarters,
    });
  });

  // Team Members sheet
  const membersSheet = workbook.addWorksheet("Team Members");
  membersSheet.columns = [
    { header: "Firm Name", key: "vcFirm", width: 30 },
    { header: "Name", key: "name", width: 30 },
    { header: "Title", key: "title", width: 30 },
    { header: "LinkedIn", key: "linkedinUrl", width: 40 },
    { header: "Email", key: "email", width: 30 },
    { header: "Portfolio Companies", key: "portfolioCompanies", width: 50 },
    { header: "Tier", key: "decisionMakerTier", width: 10 },
    { header: "Specialization", key: "specialization", width: 40 },
    // Individual investment mandate columns
    { header: "Investment Focus", key: "investmentFocus", width: 40 },
    { header: "Stage Preference", key: "stagePreference", width: 30 },
    { header: "Check Size Range", key: "checkSizeRange", width: 25 },
    { header: "Geographic Focus", key: "geographicFocus", width: 30 },
    { header: "Investment Thesis", key: "investmentThesis", width: 60 },
    { header: "Notable Investments", key: "notableInvestments", width: 50 },
    { header: "Years Experience", key: "yearsExperience", width: 20 },
    { header: "Background", key: "background", width: 50 },
  ];

  members.forEach((member) => {
    membersSheet.addRow({
      vcFirm: member.vcFirm,
      name: member.name,
      title: member.title,
      linkedinUrl: member.linkedinUrl,
      email: member.email,
      portfolioCompanies: member.portfolioCompanies || "",
      decisionMakerTier: member.decisionMakerTier,
      specialization: member.specialization,
      investmentFocus: member.investmentFocus || "",
      stagePreference: member.stagePreference || "",
      checkSizeRange: member.checkSizeRange || "",
      geographicFocus: member.geographicFocus || "",
      investmentThesis: member.investmentThesis || "",
      notableInvestments: member.notableInvestments || "",
      yearsExperience: member.yearsExperience || "",
      background: member.background || "",
    });
  });

  // Generate Excel buffer
  const buffer = await workbook.xlsx.writeBuffer();

  // Upload to S3
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileKey = `enrichment-results/${jobId}/results-${timestamp}.xlsx`;

  console.log(`Uploading to S3: ${fileKey}`);
  const { url } = await storagePut(fileKey, Buffer.from(buffer), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

  console.log(`Results file uploaded: ${url}`);

  // Update job with output file URL
  await db
    .update(enrichmentJobs)
    .set({
      outputFileUrl: url,
      outputFileKey: fileKey,
      status: "completed",
      completedAt: new Date(),
    })
    .where(eq(enrichmentJobs.id, jobId));

  console.log(`✅ Job ${jobId} marked as completed`);
  console.log(`📊 Results: ${firms.length} firms, ${members.length} team members`);
  console.log(`🔗 Download: ${url}`);
}

main().catch(console.error);
