import { COOKIE_NAME } from "../shared/const.js";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router, protectedProcedure } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { storagePut } from "./storage";
import { estimateEnrichmentCost } from "./costEstimation";
import { createEnrichmentJob, getEnrichmentJob, getUserEnrichmentJobs, updateEnrichmentJob } from "./enrichmentDb";
import { getDb } from "./db";
import { enrichedFirms, teamMembers, portfolioCompanies, investmentThesis } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { parseInputExcel, createOutputExcel, type EnrichedVCData, type TeamMemberData, type PortfolioCompanyData, type ProcessingSummaryData } from "./excelProcessor";
import { generateInvestmentThesisSummaries } from "./investmentThesisAnalyzer";
import { generateResultsFile } from "./generateResultsService";
import { createCSVExport } from "./csvExporter";
import { processBatches, DEFAULT_BATCH_CONFIG, updateJobProgressSafely } from "./batchProcessor";
import { ConnectionKeepAlive } from "./dbConnectionManager";
import { VCEnrichmentService } from "./vcEnrichment";
import { classifyDecisionMakerTier } from './decisionMakerTiers';
import { calculateRecencyScore } from './portfolioIntelligence';
import { canResumeJob, prepareJobForResume, getResumeProgress } from "./resumeJob";
import { nanoid } from "nanoid";
import { saveFirmImmediately, getProcessedFirms } from "./incrementalSave";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  enrichment: router({
    // Upload and preview file
    uploadAndPreview: protectedProcedure
      .input(
        z.object({
          fileData: z.string(), // base64 encoded file
          fileName: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        // Decode base64 and upload to S3
        const buffer = Buffer.from(input.fileData, "base64");
        const fileKey = `enrichment/${ctx.user.id}/${nanoid()}-${input.fileName}`;
        // Determine MIME type based on file extension
        const mimeType = input.fileName.toLowerCase().endsWith('.csv') 
          ? 'text/csv' 
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        
        const { url: fileUrl } = await storagePut(fileKey, buffer, mimeType);

        // Parse Excel to get preview
        const firms = await parseInputExcel(fileUrl);

        // Validate firm count
        const MAX_FIRMS_PER_JOB = 10000;
        if (firms.length > MAX_FIRMS_PER_JOB) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Too many firms in your file (${firms.length}). Maximum allowed: ${MAX_FIRMS_PER_JOB} firms per job. Please split your file into smaller batches.`,
          });
        }

        // Return preview data (first 5 firms)
      const costEstimate = estimateEnrichmentCost(firms.length);

      return {
        fileUrl,
        fileKey,
        firmCount: firms.length,
        costEstimate: {
          totalCost: costEstimate.totalCost,
          perFirmCost: costEstimate.perFirmCost,
          estimatedDuration: costEstimate.estimatedDuration,
        },
        preview: firms.slice(0, 5).map((f) => ({
          companyName: f.companyName,
          websiteUrl: f.websiteUrl,
          descriptionPreview: f.description.substring(0, 150) + (f.description.length > 150 ? "..." : ""),
        })),
      };
      }),

    // Confirm and start enrichment
    confirmAndStart: protectedProcedure
      .input(
        z.object({
          fileUrl: z.string(),
          fileKey: z.string(),
          firmCount: z.number(),
          tierFilter: z.enum(["tier1", "tier1-2", "all"]).optional().default("all"),
          deepTeamProfileScraping: z.boolean().optional().default(true),
          maxTeamProfiles: z.number().optional().default(200),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        // Create job
        const jobId = await createEnrichmentJob({
          userId: ctx.user.id,
          status: "pending",
          inputFileUrl: input.fileUrl,
          inputFileKey: input.fileKey,
          firmCount: input.firmCount,
          tierFilter: input.tierFilter || "all",
          deepTeamProfileScraping: input.deepTeamProfileScraping !== false,
          maxTeamProfiles: input.maxTeamProfiles || 200,
        });

        // Start processing in background
        processEnrichmentJob(jobId).catch((error) => {
          console.error(`Error processing job ${jobId}:`, error);
        });

        return { jobId, firmCount: input.firmCount };
      }),

    // Get job status
    getJob: protectedProcedure
      .input(z.object({ jobId: z.number() }))
      .query(async ({ ctx, input }) => {
        const job = await getEnrichmentJob(input.jobId);
        if (!job || job.userId !== ctx.user.id) {
          throw new Error("Job not found");
        }
        return job;
      }),

    // List user's jobs
    listJobs: protectedProcedure.query(async ({ ctx }) => {
      return await getUserEnrichmentJobs(ctx.user.id);
    }),

    // Resume a failed job
    resumeJob: protectedProcedure
      .input(z.object({ jobId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const job = await getEnrichmentJob(input.jobId);
        if (!job || job.userId !== ctx.user.id) {
          throw new Error("Job not found");
        }

        const resumeCheck = await canResumeJob(input.jobId);
        if (!resumeCheck.canResume) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: resumeCheck.reason || "Cannot resume this job",
          });
        }

        // Prepare job for resume
        await prepareJobForResume(input.jobId);

        // Restart processing
        processEnrichmentJob(input.jobId).catch((error) => {
          console.error(`Error resuming job ${input.jobId}:`, error);
        });

        const progress = await getResumeProgress(input.jobId);
        return {
          message: "Job resumed successfully",
          ...progress,
        };
      }),

    // Generate results file on-demand
    generateResults: protectedProcedure
      .input(z.object({ 
        jobId: z.number(),
        forceRegenerate: z.boolean().optional().default(false),
      }))
      .mutation(async ({ ctx, input }) => {
        const job = await getEnrichmentJob(input.jobId);
        if (!job || job.userId !== ctx.user.id) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Job not found",
          });
        }

        if (job.status !== "completed" && job.processedCount === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Job has not processed any firms yet",
          });
        }

        // Generate the results file
        const result = await generateResultsFile({
          jobId: input.jobId,
          forceRegenerate: input.forceRegenerate,
        });

        // Return file as base64 for download
        return {
          success: result.success,
          fileData: result.fileBuffer.toString('base64'),
          fileName: result.fileName,
          firmCount: result.firmCount,
          teamMemberCount: result.teamMemberCount,
        };
      }),

    // Export job results as CSV
    exportCSV: protectedProcedure
      .input(z.object({ jobId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const job = await getEnrichmentJob(input.jobId);
        if (!job || job.userId !== ctx.user.id) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });
        }

        if (job.status !== "completed" && job.processedCount === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Job has not processed any firms yet",
          });
        }

        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database connection failed" });

        // Fetch all enriched data from database
        const firms = await db.select().from(enrichedFirms).where(eq(enrichedFirms.jobId, input.jobId));
        const members = await db.select().from(teamMembers).where(eq(teamMembers.jobId, input.jobId));
        const portfolio = await db.select().from(portfolioCompanies).where(eq(portfolioCompanies.jobId, input.jobId));
        const thesis = await db.select().from(investmentThesis).where(eq(investmentThesis.jobId, input.jobId));

        if (firms.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "No enriched firms found for this job" });
        }

        const { buffer, filename } = await createCSVExport(
          firms as any,
          members as any,
          portfolio as any,
          thesis as any,
        );

        return {
          success: true,
          fileData: buffer.toString("base64"),
          fileName: filename,
          firmCount: firms.length,
          teamMemberCount: members.length,
        };
      }),
  }),
});

// Background job processor
export async function processEnrichmentJob(jobId: number) {
  // Start database keep-alive for long-running job
  const keepAlive = new ConnectionKeepAlive();
  keepAlive.start();
  
  try {
    await updateEnrichmentJob(jobId, { status: "processing" });

    const job = await getEnrichmentJob(jobId);
    if (!job) throw new Error("Job not found");

    // Parse input file
    const allFirms = await parseInputExcel(job.inputFileUrl);
    
    // Get list of already-processed firms from processedFirms table
    const processedFirmNames = await getProcessedFirms(jobId);
    console.log(`[Job ${jobId}] Found ${processedFirmNames.length} already-processed firms in database`);
    
    // Filter out already-processed firms to enable true resumption
    const firms = allFirms.filter(firm => !processedFirmNames.includes(firm.companyName));
    
    if (processedFirmNames.length > 0) {
      console.log(`[Job ${jobId}] Resuming job: ${processedFirmNames.length} firms already completed, ${firms.length} remaining`);
    } else {
      console.log(`[Job ${jobId}] Starting fresh with ${allFirms.length} firms`);
    }

    // Initialize enrichment service
    const enricher = new VCEnrichmentService();

    const enrichedFirmsData: EnrichedVCData[] = [];
    const allTeamMembers: TeamMemberData[] = [];
    const allPortfolioCompanies: PortfolioCompanyData[] = [];

    // Use batch processor for reliable large-scale processing
    const batchConfig = {
      ...DEFAULT_BATCH_CONFIG,
      batchSize: 500, // Process 500 firms per batch
      progressUpdateInterval: 10, // Update DB every 10 firms
    };

    let currentFirmName = "";
    let currentTeamMemberCount = 0;

    await processBatches(
      firms,
      async (firm) => {
        const result = await enricher.enrichVCFirm(
          firm.companyName,
          firm.websiteUrl,
          firm.description,
          undefined, // onProgress callback
          {
            deepTeamProfileScraping: job.deepTeamProfileScraping !== false,
            maxTeamProfiles: job.maxTeamProfiles || 200,
          }
        );
        return result;
      },
      batchConfig,
      {
        onBatchStart: (batchIndex, batchSize) => {
          console.log(`[Job ${jobId}] Starting batch ${batchIndex + 1}, size: ${batchSize}`);
        },
        onItemComplete: async (firm, result, index) => {
          currentFirmName = result.companyName;
          currentTeamMemberCount = result.teamMembers.length;
          
          // INCREMENTAL SAVE: Save firm immediately to database
          console.log(`[Job ${jobId}] 💾 Saving "${result.companyName}" to database immediately...`);
          const firmId = await saveFirmImmediately(jobId, result, job.tierFilter || "all");
          
          if (!firmId) {
            console.error(`[Job ${jobId}] ❌ Failed to save "${result.companyName}" to database`);
            return;
          }
          
          console.log(`[Job ${jobId}] ✅ Saved "${result.companyName}" (ID: ${firmId}) with ${result.teamMembers.length} team members`);
          
          // Keep in-memory copy for Excel generation (but data is already safe in DB)
          const existingFirm = enrichedFirmsData.find(f => f.companyName === result.companyName);
          if (existingFirm) {
            console.error(`[Job ${jobId}] ⚠️  DUPLICATE DETECTED: ${result.companyName} already in enrichedFirmsData array!`);
            console.error(`[Job ${jobId}] Skipping duplicate to prevent database duplication`);
            return; // Skip adding this duplicate
          }
          
          console.log(`[Job ${jobId}] Adding ${result.companyName} to enrichedFirmsData (current count: ${enrichedFirmsData.length})`);
          enrichedFirmsData.push({
            companyName: result.companyName,
            websiteUrl: result.websiteUrl,
            description: result.description,
            websiteVerified: result.websiteVerified ? "Yes" : "No",
            verificationMessage: result.verificationMessage,
            investorType: result.investorType.join(", "),
            investorTypeConfidence: result.investorTypeConfidence,
            investorTypeSourceUrl: result.investorTypeSourceUrl,
            investmentStages: result.investmentStages.join(", "),
            investmentStagesConfidence: result.investmentStagesConfidence,
            investmentStagesSourceUrl: result.investmentStagesSourceUrl,
            investmentNiches: result.investmentNiches.join(", "),
            nichesConfidence: result.nichesConfidence,
            nichesSourceUrl: result.nichesSourceUrl,
          });

          // Add team members with tier classification
          console.log(`[Job ${jobId}] Firm "${result.companyName}" extracted ${result.teamMembers.length} team members`);
          
          for (const member of result.teamMembers) {
            const tierClassification = classifyDecisionMakerTier(member.title);
            console.log(`[Job ${jobId}] Team member: ${member.name} | Title: "${member.title}" | Tier: ${tierClassification.tier}`);
            
            // Apply tier filter based on job settings
            const tierFilter = job.tierFilter || "all";
            let includeMember = false;
            
            if (tierFilter === "tier1" && tierClassification.tier === "Tier 1") {
              includeMember = true;
            } else if (tierFilter === "tier1-2" && (tierClassification.tier === "Tier 1" || tierClassification.tier === "Tier 2" || tierClassification.tier === "Tier 3")) {
              // Include Tier 3 in tier1-2 filter to be more inclusive
              includeMember = true;
            } else if (tierFilter === "all") {
              // When filter is "all", include ALL team members regardless of tier classification
              // This ensures no data loss - users can filter in Excel if needed
              includeMember = true;
            }
            
            console.log(`[Job ${jobId}] ${member.name} | Filter: ${tierFilter} | Include: ${includeMember}`);
            
            if (includeMember) {
              console.log(`[Job ${jobId}] ✓ Including ${member.name} in results`);
              allTeamMembers.push({
                vcFirm: result.companyName,
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
                decisionMakerTier: tierClassification.tier,
                tierPriority: tierClassification.priority,
              });
            } else {
              console.log(`[Job ${jobId}] ✗ Excluding ${member.name} from results (Tier: ${tierClassification.tier}, Filter: ${tierFilter})`);
            }
          }

          // Add portfolio companies with recency scoring
          for (const company of result.portfolioCompanies) {
            const { score, category } = calculateRecencyScore(company.investmentDate);
            
            allPortfolioCompanies.push({
              vcFirm: result.companyName,
              portfolioCompany: company.companyName,
              investmentDate: company.investmentDate,
              websiteUrl: company.websiteUrl,
              investmentNiche: company.investmentNiche.join(", "),
              dataSourceUrl: company.dataSourceUrl,
              confidenceScore: company.confidenceScore,
              recencyScore: score,
              recencyCategory: category,
            });
          }
        },
        onItemError: (firm, error, index) => {
          console.error(`[Job ${jobId}] Error processing firm ${index} (${firm.companyName}):`, error);
        },
        onProgressUpdate: async (processed, total) => {
          // Use safe DB update with retry logic
          // Calculate absolute processed count
          const absoluteProcessed = processedFirmNames.length + processed;
          await updateJobProgressSafely(jobId, {
            processedCount: absoluteProcessed,
            currentFirmName,
            currentTeamMemberCount,
          });
          console.log(`[Job ${jobId}] Progress: ${absoluteProcessed}/${allFirms.length} firms (${Math.round(absoluteProcessed/allFirms.length*100)}%)`);
        },
        onBatchComplete: (batchIndex, results) => {
          console.log(`[Job ${jobId}] Batch ${batchIndex + 1} complete: ${results.length} firms enriched`);
        },
      }
    );

    // Generate investment thesis summaries
    const investmentThesisSummaries = generateInvestmentThesisSummaries(
      enrichedFirmsData,
      allTeamMembers,
      allPortfolioCompanies
    );

    // Generate processing summary
    const processingSummaryData: ProcessingSummaryData[] = enrichedFirmsData.map(firm => {
      const firmTeamMembers = allTeamMembers.filter(m => m.vcFirm === firm.companyName);
      const tier1Count = firmTeamMembers.filter(m => m.decisionMakerTier === "Tier 1").length;
      const tier2Count = firmTeamMembers.filter(m => m.decisionMakerTier === "Tier 2").length;
      const tier3Count = firmTeamMembers.filter(m => m.decisionMakerTier === "Tier 3").length;
      const portfolioCount = allPortfolioCompanies.filter(p => p.vcFirm === firm.companyName).length;
      
      // Determine status and error message
      let status = "Success";
      let errorMessage = "";
      let dataCompleteness = "Complete";
      
      if (firm.websiteVerified === "No") {
        status = "Warning";
        errorMessage = firm.verificationMessage || "Website verification failed";
        dataCompleteness = "Partial - Website not accessible";
      } else if (firmTeamMembers.length === 0 && portfolioCount === 0) {
        status = "Warning";
        errorMessage = "No team members or portfolio companies found";
        dataCompleteness = "Minimal";
      } else if (firmTeamMembers.length === 0) {
        status = "Warning";
        errorMessage = "No team members found";
        dataCompleteness = "Partial - Missing team data";
      } else if (portfolioCount === 0) {
        status = "Warning";
        errorMessage = "No portfolio companies found";
        dataCompleteness = "Partial - Missing portfolio data";
      }
      
      return {
        firmName: firm.companyName,
        website: firm.websiteUrl,
        status,
        errorMessage,
        teamMembersFound: firmTeamMembers.length,
        tier1Count,
        tier2Count,
        tier3Count,
        portfolioCompaniesFound: portfolioCount,
        dataCompleteness,
      };
    });

    // All firms/team members/portfolio companies were already saved incrementally
    // by saveFirmImmediately() during processing. Only save investment thesis here,
    // since it requires aggregating data across all firms first.
    console.log(`[processEnrichmentJob] Saving investment thesis summaries for ${investmentThesisSummaries.length} firms...`);
    const db = await getDb();
    if (!db) throw new Error("Database connection failed");

    for (const firmThesis of investmentThesisSummaries) {
      // Check if already saved
      const existingThesis = await db.select().from(investmentThesis)
        .where(and(
          eq(investmentThesis.jobId, jobId),
          eq(investmentThesis.vcFirm, firmThesis.vcFirm)
        ))
        .limit(1);

      if (existingThesis.length > 0) {
        console.log(`[processEnrichmentJob] ⏭️  Skipping duplicate investment thesis for ${firmThesis.vcFirm}`);
        continue;
      }

      // Look up the firmId from the already-saved enrichedFirms row
      const [savedFirm] = await db.select({ id: enrichedFirms.id })
        .from(enrichedFirms)
        .where(and(
          eq(enrichedFirms.jobId, jobId),
          eq(enrichedFirms.companyName, firmThesis.vcFirm)
        ))
        .limit(1);

      if (!savedFirm) {
        console.warn(`[processEnrichmentJob] No saved firm found for thesis: ${firmThesis.vcFirm}, skipping`);
        continue;
      }

      await db.insert(investmentThesis).values({
        jobId,
        firmId: savedFirm.id,
        vcFirm: firmThesis.vcFirm,
        websiteUrl: firmThesis.websiteUrl || null,
        investorType: firmThesis.investorType || null,
        primaryFocusAreas: firmThesis.primaryFocusAreas || null,
        emergingInterests: firmThesis.emergingInterests || null,
        preferredStages: firmThesis.preferredStages || null,
        averageCheckSize: firmThesis.averageCheckSize || null,
        recentInvestmentPace: firmThesis.recentInvestmentPace || null,
        keyDecisionMakers: firmThesis.keyDecisionMakers || null,
        totalTeamSize: typeof firmThesis.totalTeamSize === 'number' ? firmThesis.totalTeamSize : null,
        tier1Count: typeof firmThesis.tier1Count === 'number' ? firmThesis.tier1Count : null,
        tier2Count: typeof firmThesis.tier2Count === 'number' ? firmThesis.tier2Count : null,
        portfolioSize: typeof firmThesis.portfolioSize === 'number' ? firmThesis.portfolioSize : null,
        recentPortfolioCount: typeof firmThesis.recentPortfolioCount === 'number' ? firmThesis.recentPortfolioCount : null,
        talkingPoints: firmThesis.talkingPoints || null,
      });
      console.log(`[processEnrichmentJob] ✓ Saved investment thesis for ${firmThesis.vcFirm}`);
    }

    console.log(`[processEnrichmentJob] ✅ Investment thesis saved. Job complete.`);
    
    // Mark job as completed (file generation happens on-demand when user clicks download)
    console.log(`[processEnrichmentJob] Job ${jobId} completed. Processed ${enrichedFirmsData.length} firms with ${allTeamMembers.length} team members.`);
    console.log(`[processEnrichmentJob] File will be generated on-demand when user requests download.`);
    
    await updateEnrichmentJob(jobId, {
      status: "completed",
      completedAt: new Date(),
    });
  } catch (error) {
    console.error(`Error processing job ${jobId}:`, error);
    await updateEnrichmentJob(jobId, {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  } finally {
    // Stop keep-alive when job completes or fails
    keepAlive.stop();
  }
}

export type AppRouter = typeof appRouter;
