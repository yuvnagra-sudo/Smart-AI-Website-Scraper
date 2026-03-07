import { COOKIE_NAME } from "../shared/const.js";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router, protectedProcedure } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { storagePut, storageGet } from "./storage";
import { estimateEnrichmentCost } from "./costEstimation";
import { createEnrichmentJob, getEnrichmentJob, getUserEnrichmentJobs, getAllEnrichmentJobs, updateEnrichmentJob, insertJobLog, getJobLogs } from "./enrichmentDb";
import { getDb } from "./db";
import { enrichedFirms, teamMembers, portfolioCompanies, investmentThesis } from "../drizzle/schema";
import { eq, and, like, count } from "drizzle-orm";
import { parseInputExcel, parseInputHeaders, createOutputExcel, createAgentOutputExcel, type EnrichedVCData, type TeamMemberData, type PortfolioCompanyData, type ProcessingSummaryData, type FileHeaders } from "./excelProcessor";
import { scrapeUrl, type AgentSection, type DirectoryEntry as AgentDirectoryEntry, type ScrapeStats } from "./agentScraper";
import { generateInvestmentThesisSummaries } from "./investmentThesisAnalyzer";
import { generateResultsFile } from "./generateResultsService";
import { createCSVExport } from "./csvExporter";
import { updateJobProgressSafely, incrementJobProcessedCountSafely } from "./batchProcessor";
import { ConnectionKeepAlive } from "./dbConnectionManager";
import { VCEnrichmentService } from "./vcEnrichment";
import { getOpenAIStats } from "./_core/openaiLLM";
import { classifyDecisionMakerTier } from './decisionMakerTiers';
import { calculateRecencyScore } from './portfolioIntelligence';
import { canResumeJob, prepareJobForResume, getResumeProgress } from "./resumeJob";
import { extractDirectory } from "./directoryExtractor";
import { nanoid } from "nanoid";
import { saveFirmImmediately, getProcessedFirms } from "./incrementalSave";
import { isJobCancelled } from "./_core/jobCancellation";
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
          fileData: z.string().optional(), // base64 encoded file (omitted on re-submit with mapping)
          fileName: z.string().optional(),
          fileUrl: z.string().optional(),   // provided on re-submit with mapping
          fileKey: z.string().optional(),   // provided on re-submit with mapping
          columnMapping: z.object({
            companyNameColumn: z.string().optional(),
            websiteUrlColumn: z.string(),
            descriptionColumn: z.string().optional(),
          }).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        let fileUrl: string;
        let fileKey: string;

        if (input.fileUrl && input.fileKey) {
          // Re-submit with column mapping — file already uploaded
          fileUrl = input.fileUrl;
          fileKey = input.fileKey;
        } else if (input.fileData && input.fileName) {
          // First upload — decode and store
          const buffer = Buffer.from(input.fileData, "base64");
          fileKey = `enrichment/${ctx.user.id}/${nanoid()}-${input.fileName}`;
          const mimeType = input.fileName.toLowerCase().endsWith('.csv')
            ? 'text/csv'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
          const result = await storagePut(fileKey, buffer, mimeType);
          fileUrl = result.url;
        } else {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Provide either fileData+fileName or fileUrl+fileKey" });
        }

        // Always get headers for the edit column mapping link
        const headers = await parseInputHeaders(fileUrl);

        // Try parsing — with explicit mapping or auto-detect
        try {
          const firms = await parseInputExcel(fileUrl, input.columnMapping);

          const MAX_FIRMS_PER_JOB = 10000;
          if (firms.length > MAX_FIRMS_PER_JOB) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Too many firms (${firms.length}). Maximum: ${MAX_FIRMS_PER_JOB}. Split into smaller batches.`,
            });
          }

          const avgDescLength = firms.length > 0
            ? firms.reduce((sum, f) => sum + (f.description?.length ?? 0), 0) / firms.length
            : 200;
          const costEstimate = estimateEnrichmentCost(firms.length, avgDescLength);

          return {
            status: "ready" as const,
            fileUrl,
            fileKey,
            firmCount: firms.length,
            avgDescriptionLength: Math.round(avgDescLength),
            costEstimate: {
              totalCost: costEstimate.totalCost,
              totalCostLow: costEstimate.totalCostLow,
              totalCostHigh: costEstimate.totalCostHigh,
              perFirmCost: costEstimate.perFirmCost,
              estimatedDuration: costEstimate.estimatedDuration,
            },
            preview: firms.slice(0, 5).map((f) => ({
              companyName: f.companyName,
              websiteUrl: f.websiteUrl,
              descriptionPreview: f.description.substring(0, 150) + (f.description.length > 150 ? "..." : ""),
            })),
            headers,
          };
        } catch (err) {
          // Return to column mapping UI with an error message so user can try different columns
          const mappingError = err instanceof Error ? err.message : "Could not parse file — please check your column mapping";
          return {
            status: "needs_mapping" as const,
            fileUrl,
            fileKey,
            headers,
            mappingError: input.columnMapping ? mappingError : undefined,
          };
        }
      }),

    // Discover entries from a directory URL (autonomous crawl with pagination)
    discoverFromUrl: protectedProcedure
      .input(z.object({
        directoryUrl: z.string().url(),
        maxPages: z.number().int().min(1).max(500).default(50),
      }))
      .mutation(async ({ input, ctx }) => {
        const { entries, pagesVisited, errors } = await extractDirectory(input.directoryUrl, {
          maxPages: input.maxPages,
          delayMs: 800,
        });

        if (entries.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `No entries found (visited ${pagesVisited} page(s)${errors.length ? "; " + errors[0] : ""})`,
          });
        }

        // Build CSV from discovered entries
        const csvLines = ["Company Name,Website URL"];
        for (const e of entries) {
          csvLines.push(`"${e.name.replace(/"/g, '""')}","${e.url}"`);
        }
        const csv = csvLines.join("\n");

        const fileKey = `enrichment/${ctx.user.id}/${nanoid()}-discovery.csv`;
        const stored = await storagePut(fileKey, Buffer.from(csv, "utf-8"), "text/csv");
        const costEstimate = estimateEnrichmentCost(entries.length, 200);

        return {
          status: "ready" as const,
          fileUrl: stored.url,
          fileKey: stored.key,
          firmCount: entries.length,
          avgDescriptionLength: 200,
          pagesVisited,
          costEstimate: {
            totalCost: costEstimate.totalCost,
            totalCostLow: costEstimate.totalCostLow,
            totalCostHigh: costEstimate.totalCostHigh,
            perFirmCost: costEstimate.perFirmCost,
            estimatedDuration: costEstimate.estimatedDuration,
          },
          preview: entries.slice(0, 5).map(e => ({
            companyName: e.name,
            websiteUrl: e.url,
            descriptionPreview: "",
          })),
          headers: {
            columns: ["Company Name", "Website URL"],
            sampleRows: [] as Array<Record<string, string>>,
            autoDetected: { companyName: "Company Name", websiteUrl: "Website URL" },
          },
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
          template: z.string().optional().default("vc"),
          avgDescriptionLength: z.number().optional().default(200),
          // Agentic extraction fields
          sectionsJson: z.string().optional(),
          systemPrompt: z.string().optional(),
          objective: z.string().optional(),
          // Column mapping (for non-standard column names)
          columnMapping: z.object({
            companyNameColumn: z.string().optional(),
            websiteUrlColumn: z.string(),
            descriptionColumn: z.string().optional(),
          }).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        // Compute cost estimate (using description length for accuracy)
        const avgDescLen = input.avgDescriptionLength ?? 200;
        const estimate = estimateEnrichmentCost(input.firmCount, avgDescLen);

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
          template: input.template || "vc",
          estimatedCostUSD: String(estimate.totalCost),
          sectionsJson: input.sectionsJson,
          systemPrompt: input.systemPrompt,
          objective: input.objective,
          columnMappingJson: input.columnMapping ? JSON.stringify(input.columnMapping) : undefined,
        });

        // Job will be picked up by worker.ts via polling (within 5 seconds)
        // Do NOT call processAgentJob/processEnrichmentJob directly here — that causes
        // dual processing: once from this web server (no heartbeat) and again when
        // worker.ts sees it as stale and picks it up a second time.
        console.log(`[confirmAndStart] Job ${jobId} queued — worker will pick up within 5s`);

        return { jobId, firmCount: input.firmCount };
      }),

    // Generate AI extraction plan from user description
    generateExtractionPlan: protectedProcedure
      .input(z.object({ description: z.string().min(10) }))
      .mutation(async ({ input }) => {
        const { queuedLLMCall } = await import("./_core/llmQueue");

        // FIX: Raised section cap from 3-8 to 3-15. The old 8-section limit caused the
        // LLM to silently merge or drop fields when users asked for more columns.
        const systemMsg = `You are a web data extraction architect. Parse the user's intent into a structured extraction plan.

Rules for sections:
- 3-15 sections total (use as many as the user's request requires, up to 15)
- Each section key: snake_case, max 40 chars — MUST exactly match the field names used in systemPrompt
- Each section label: 2-4 words, suitable as a CSV column header
- Each section desc: 1-2 sentence research instruction
- IMPORTANT: Every field name mentioned in systemPrompt MUST have a matching key in sections

Return ONLY valid JSON (no markdown, no code fences):
{
  "objective": "one concise sentence describing what to find",
  "sections": [{"key":"snake_case_key","label":"Display Name","desc":"Research instruction"}],
  "systemPrompt": "Complete extraction prompt. Start with 'You are a [role]. Extract the following fields from the provided page content:' followed by numbered **Bold** sections with instructions. Include {companyName} and {websiteUrl} as placeholders. Use ONLY the exact snake_case keys defined in sections."
}`;

        try {
          const response = await queuedLLMCall({
            messages: [
              { role: "system", content: systemMsg },
              { role: "user", content: input.description.trim() },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "extraction_plan",
                strict: true,
                schema: {
                  type: "object",
                  properties: {
                    objective: { type: "string" },
                    sections: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          key: { type: "string" },
                          label: { type: "string" },
                          desc: { type: "string" },
                        },
                        required: ["key", "label", "desc"],
                        additionalProperties: false,
                      },
                    },
                    systemPrompt: { type: "string" },
                  },
                  required: ["objective", "sections", "systemPrompt"],
                  additionalProperties: false,
                },
              },
            },
          });

          const raw = response.choices[0]?.message?.content ?? "{}";
          const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");

          // Validate + clean sections
          const sections: AgentSection[] = (parsed.sections ?? [])
            .slice(0, 15)
            .map((s: any) => ({
              key: String(s.key ?? "")
                .toLowerCase()
                .replace(/[^a-z0-9_]/g, "_")
                .slice(0, 40),
              label: String(s.label ?? "Section"),
              desc: String(s.desc ?? ""),
            }))
            .filter((s: AgentSection) => s.key && s.label);

          if (sections.length === 0) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "AI did not generate any sections. Try a more descriptive request.",
            });
          }

          // FIX: Validate that the systemPrompt only references keys that exist in sections.
          // A mismatch means extracted data goes into a column that doesn't exist in the output.
          const sectionKeys = new Set(sections.map((s: AgentSection) => s.key));
          let validatedSystemPrompt = String(parsed.systemPrompt ?? "");
          // Rebuild the systemPrompt from sections to guarantee alignment
          const sectionList = sections
            .map((s: AgentSection, i: number) => `${i + 1}. **${s.label}** (key: ${s.key}): ${s.desc}`)
            .join("\n");
          if (validatedSystemPrompt) {
            // Append a strict key reminder to the generated prompt
            validatedSystemPrompt += `\n\nIMPORTANT: Return ONLY these exact JSON keys: ${sections.map((s: AgentSection) => s.key).join(", ")}`;
          } else {
            validatedSystemPrompt = `You are a data extraction assistant for {companyName} ({websiteUrl}).\nExtract the following fields from the provided page content:\n${sectionList}\n\nReturn ONLY these exact JSON keys: ${sections.map((s: AgentSection) => s.key).join(", ")}`;
          }

          return {
            objective: String(parsed.objective ?? input.description),
            sections,
            systemPrompt: validatedSystemPrompt,
          };
        } catch (err: any) {
          if (err instanceof TRPCError) throw err;
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Generation failed: ${err.message ?? "Unknown error"}`,
          });
        }
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

    // Admin: list all jobs across all users
    listAllJobsAdmin: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "admin") throw new Error("Forbidden");
      return await getAllEnrichmentJobs();
    }),

    // Get per-URL job logs for quality report
    getJobLogs: protectedProcedure
      .input(z.object({ jobId: z.number() }))
      .query(async ({ ctx, input }) => {
        const job = await getEnrichmentJob(input.jobId);
        if (!job || job.userId !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND" });
        return await getJobLogs(input.jobId);
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

        // FIX: Re-queue the job as "pending" so the background worker picks it up.
        // Previously this called processEnrichmentJob() directly from the web server
        // process, which has no heartbeat, no cancellation timer, and no keepAlive —
        // making resumed jobs extremely fragile.
        await updateEnrichmentJob(input.jobId, { status: "pending", workerPid: null, heartbeatAt: null });
        console.log(`[resumeJob] Job ${input.jobId} re-queued as pending — worker will pick up within 5s`);

        const progress = await getResumeProgress(input.jobId);
        return {
          message: "Job resumed successfully — worker will pick it up within 5 seconds",
          ...progress,
        };
      }),
    // Cancel a running or pending job
    cancelJob: protectedProcedure
      .input(z.object({ jobId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const job = await getEnrichmentJob(input.jobId);
        if (!job || job.userId !== ctx.user.id) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });
        }
        if (job.status === "completed" || job.status === "cancelled") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Job is already ${job.status}`,
          });
        }
        // Write cancelled status to DB. The worker's cancellation poller (every 5s)
        // will detect this and call markJobCancelled(jobId), which causes
        // processAgentJob / scrapeUrl to throw JOB_CANCELLED and stop cleanly.
        await updateEnrichmentJob(input.jobId, {
          status: "cancelled",
          completedAt: new Date(),
          errorMessage: "Cancelled by user",
        });
        console.log(`[cancelJob] Job ${input.jobId} marked as cancelled in DB`);
        return { message: "Job cancellation requested — worker will stop within 5 seconds" };
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

        // Agent jobs (AI Custom extraction): results are stored in S3, not in enrichedFirms
        if (job.sectionsJson && job.outputFileKey) {
          const { url } = await storageGet(job.outputFileKey);
          const response = await fetch(url);
          if (!response.ok) {
            throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Results file not available in storage" });
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          return {
            success: true,
            fileData: buffer.toString("base64"),
            fileName: `agent-results-${input.jobId}.xlsx`,
            firmCount: job.processedCount ?? 0,
            teamMemberCount: 0,
          };
        }

        if (job.status !== "completed" && job.processedCount === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Job has not processed any firms yet",
          });
        }

        // Standard jobs: generate from enrichedFirms table
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

    // Get paginated job results for in-app table view
    getJobResults: protectedProcedure
      .input(z.object({
        jobId: z.number(),
        tab: z.enum(["firms", "team", "portfolio"]),
        page: z.number().min(1).default(1),
        search: z.string().optional(),
      }))
      .query(async ({ ctx, input }) => {
        const job = await getEnrichmentJob(input.jobId);
        if (!job || job.userId !== ctx.user.id) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });
        }

        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database connection failed" });

        const PAGE_SIZE = 50;
        const offset = (input.page - 1) * PAGE_SIZE;
        const searchTerm = input.search ? `%${input.search}%` : null;

        if (input.tab === "firms") {
          const whereClause = searchTerm
            ? and(eq(enrichedFirms.jobId, input.jobId), like(enrichedFirms.companyName, searchTerm))
            : eq(enrichedFirms.jobId, input.jobId);
          const [rows, totalRows] = await Promise.all([
            db.select().from(enrichedFirms).where(whereClause).limit(PAGE_SIZE).offset(offset),
            db.select({ total: count() }).from(enrichedFirms).where(whereClause),
          ]);
          return { rows, total: totalRows[0]?.total ?? 0, pages: Math.ceil((totalRows[0]?.total ?? 0) / PAGE_SIZE) };
        }

        if (input.tab === "team") {
          const whereClause = searchTerm
            ? and(eq(teamMembers.jobId, input.jobId), like(teamMembers.name, searchTerm))
            : eq(teamMembers.jobId, input.jobId);
          const [rows, totalRows] = await Promise.all([
            db.select().from(teamMembers).where(whereClause).limit(PAGE_SIZE).offset(offset),
            db.select({ total: count() }).from(teamMembers).where(whereClause),
          ]);
          return { rows, total: totalRows[0]?.total ?? 0, pages: Math.ceil((totalRows[0]?.total ?? 0) / PAGE_SIZE) };
        }

        // portfolio tab
        const whereClause = searchTerm
          ? and(eq(portfolioCompanies.jobId, input.jobId), like(portfolioCompanies.portfolioCompany, searchTerm))
          : eq(portfolioCompanies.jobId, input.jobId);
        const [rows, totalRows] = await Promise.all([
          db.select().from(portfolioCompanies).where(whereClause).limit(PAGE_SIZE).offset(offset),
          db.select({ total: count() }).from(portfolioCompanies).where(whereClause),
        ]);
        return { rows, total: totalRows[0]?.total ?? 0, pages: Math.ceil((totalRows[0]?.total ?? 0) / PAGE_SIZE) };
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

    // Parse input file (with column mapping if user overrode defaults)
    const columnMapping = job.columnMappingJson ? JSON.parse(job.columnMappingJson) : undefined;
    const allFirms = await parseInputExcel(job.inputFileUrl, columnMapping);
    
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

    // Concurrent worker queue — processes up to CONCURRENCY firms simultaneously.
    // Node.js is single-threaded so queue.shift() and Set mutations are race-free.
    const CONCURRENCY = 50;
    const firmQueue = [...firms];
    const activeFirms = new Set<string>();
    let parallelProcessedCount = 0;

    const processFirm = async (firm: typeof firms[number]) => {
      const result = await enricher.enrichVCFirm(
        firm.companyName,
        firm.websiteUrl,
        firm.description,
        undefined,
        {
          deepTeamProfileScraping: job.deepTeamProfileScraping !== false,
          maxTeamProfiles: job.maxTeamProfiles || 200,
        }
      );

      // INCREMENTAL SAVE: persist to DB immediately
      console.log(`[Job ${jobId}] 💾 Saving "${result.companyName}"...`);
      const firmId = await saveFirmImmediately(jobId, result, job.tierFilter || "all");
      if (!firmId) {
        console.error(`[Job ${jobId}] ❌ Failed to save "${result.companyName}"`);
        return;
      }
      console.log(`[Job ${jobId}] ✅ Saved "${result.companyName}" (ID: ${firmId}) with ${result.teamMembers.length} members`);

      // Keep in-memory copies for investment thesis generation
      if (!enrichedFirmsData.find(f => f.companyName === result.companyName)) {
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
      }

      const tierFilter = job.tierFilter || "all";
      for (const member of result.teamMembers) {
        const tierClassification = classifyDecisionMakerTier(member.title);
        const include =
          (tierFilter === "tier1" && tierClassification.tier === "Tier 1") ||
          (tierFilter === "tier1-2" && ["Tier 1", "Tier 2", "Tier 3"].includes(tierClassification.tier)) ||
          tierFilter === "all";
        if (include) {
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
        }
      }

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
    };

    const runWorker = async (): Promise<void> => {
      while (true) {
        const firm = firmQueue.shift();
        if (!firm) break;

        activeFirms.add(firm.companyName);
        try {
          await processFirm(firm);
          parallelProcessedCount++;
        } catch (err) {
          parallelProcessedCount++;
          const _errMsg = err instanceof Error ? err.message : String(err);
          const _isAxios = (err as any)?.isAxiosError || (err as any)?.response?.status;
          if (_isAxios) {
            const _status = (err as any)?.response?.status ?? 'unknown';
            console.error(`[Job ${jobId}] HTTP ${_status} error for "${firm.companyName}": ${_errMsg.slice(0, 200)}`);
          } else {
            console.error(`[Job ${jobId}] Error enriching "${firm.companyName}": ${_errMsg.slice(0, 500)}`);
          }
        } finally {
          activeFirms.delete(firm.companyName);
          const activeFirmsList = [...activeFirms];
          const currentStats = getOpenAIStats();
          await incrementJobProcessedCountSafely(jobId);
          await updateJobProgressSafely(jobId, {
            currentFirmName: activeFirmsList[0] ?? null,
            currentTeamMemberCount: null,
            activeFirmsJson: activeFirmsList.length > 0 ? JSON.stringify(activeFirmsList) : null,
            totalCostUSD:       Math.round((currentStats.totalCost - costBaseline) * 10000) / 10000,
            totalInputTokens:   currentStats.totalInputTokens  - inputBaseline,
            totalOutputTokens:  currentStats.totalOutputTokens - outputBaseline,
          });
          console.log(`[Job ${jobId}] Progress: ${parallelProcessedCount}/${allFirms.length} (${activeFirms.size} active)`);
        }
      }
    };

    // Snapshot LLM stats before processing so we can compute job-specific cost delta
    const statsBaseline = getOpenAIStats();
    const costBaseline   = statsBaseline.totalCost;
    const inputBaseline  = statsBaseline.totalInputTokens;
    const outputBaseline = statsBaseline.totalOutputTokens;

    console.log(`[Job ${jobId}] Starting parallel enrichment: ${firms.length} firms, ${CONCURRENCY} concurrent`);
    await Promise.allSettled(
      Array.from({ length: Math.min(CONCURRENCY, firms.length) }, runWorker)
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
    
    const finalStats = getOpenAIStats();
    await updateEnrichmentJob(jobId, {
      status: "completed",
      completedAt: new Date(),
      totalCostUSD:       String(Math.round((finalStats.totalCost - costBaseline) * 10000) / 10000),
      totalInputTokens:   finalStats.totalInputTokens  - inputBaseline,
      totalOutputTokens:  finalStats.totalOutputTokens - outputBaseline,
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

// ---------------------------------------------------------------------------
// Error classifier for job logs
// ---------------------------------------------------------------------------

function classifyAgentError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes("403") || lower.includes("blocked") || lower.includes("rate limit") || lower.includes("429")) return "scraper_blocked";
  if (lower.includes("4") && lower.match(/\b[45]\d\d\b/)) return "http_error";
  if (lower.includes("5") && lower.match(/\b5\d\d\b/)) return "http_error";
  if (lower.includes("timeout") || lower.includes("econnreset") || lower.includes("econnrefused")) return "http_error";
  if (lower.includes("no content") || lower.includes("empty page") || lower.includes("no text")) return "no_content";
  if (lower.includes("llm") || lower.includes("openai") || lower.includes("parse")) return "llm_empty";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Agentic job processor (custom sections mode)
// ---------------------------------------------------------------------------

export async function processAgentJob(jobId: number) {
  const keepAlive = new ConnectionKeepAlive();
  keepAlive.start(); // FIX: was missing — prevents MySQL connection timeout on long agent jobs

  try {
    const job = await getEnrichmentJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    await updateEnrichmentJob(jobId, { status: "processing", startedAt: new Date() });

    const sections: AgentSection[] = JSON.parse(job.sectionsJson ?? "[]");
    const systemPrompt = job.systemPrompt ?? "";
    const objective = job.objective ?? "";

    const columnMapping = job.columnMappingJson ? JSON.parse(job.columnMappingJson) : undefined;
    const firms = await parseInputExcel(job.inputFileUrl, columnMapping);
    console.log(`[processAgentJob] Job ${jobId}: ${firms.length} URLs, ${sections.length} sections`);

    // FIX: Sync firmCount in DB to the actual parsed count.
    // The client-side preview count may differ from the real parsed count
    // (e.g. rows with missing URLs are filtered out), causing the progress bar
    // to never reach 100%.
    if (firms.length !== job.firmCount) {
      console.log(`[processAgentJob] Correcting firmCount: DB=${job.firmCount}, actual=${firms.length}`);
      await updateEnrichmentJob(jobId, { firmCount: firms.length });
    }

    const profileResults: Array<Record<string, string>> = [];
    const collectedUrls: AgentDirectoryEntry[] = [];
    let processed = 0;

    // FIX: Reduced from 50 to 10. With 50 concurrent workers, a cancel event
    // leaves up to 50 in-flight LLM calls that must complete before the job
    // actually stops. 10 is still fast and dramatically reduces cancel latency.
    const CONCURRENCY = 10;
    const firmQueue = [...firms];

    const runWorker = async () => {
      while (firmQueue.length > 0) {
        const firm = firmQueue.shift();
        if (!firm) break;

        // FIX: Check cancellation at the start of every firm (before any work)
        if (isJobCancelled(jobId)) {
          console.log(`[processAgentJob] Job ${jobId} cancelled — stopping`);
          firmQueue.length = 0;
          break;
        }

        // Use per-row objective (Description column) if present, else global objective
        const rowObjective = firm.description?.trim() || objective;
        const startMs = Date.now();

        // Substitute template variables in system prompt
        const resolvedPrompt = systemPrompt
          .replace(/\{companyName\}/g, firm.companyName)
          .replace(/\{websiteUrl\}/g, firm.websiteUrl);

        try {
          const result = await scrapeUrl(
            firm.websiteUrl,
            rowObjective,
            sections,
            resolvedPrompt,
            5,
            () => isJobCancelled(jobId), // FIX: pass cancellation callback so scrapeUrl can abort mid-hop
          );

          if (result.type === "directory") {
            collectedUrls.push(...result.entries);
            // Queue each discovered directory entry for individual profile scraping.
            // Without this, entries only appear on a "Collected URLs" sheet and are never
            // enriched with the user's custom sections.
            for (const entry of result.entries) {
              const scrapeTarget = entry.nativeUrl || entry.directoryUrl;
              if (scrapeTarget && scrapeTarget !== firm.websiteUrl) {
                firmQueue.push({
                  companyName: entry.name || scrapeTarget,
                  websiteUrl: scrapeTarget,
                  description: rowObjective,
                });
              }
            }
            console.log(`[processAgentJob] Directory expanded: ${result.entries.length} entries queued for scraping`);
            insertJobLog({ jobId, url: firm.websiteUrl, companyName: firm.companyName, status: "success", fieldsTotal: 0, fieldsFilled: 0, durationMs: Date.now() - startMs }).catch(() => {});
          } else {
            profileResults.push({
              "Company Name": firm.companyName,
              "Website": firm.websiteUrl,
              ...result.data,
            });
            const stats: ScrapeStats = result.stats;
            const logStatus = stats.fieldsFilled === 0 ? "failed" : stats.fieldsFilled < stats.fieldsTotal ? "partial" : "success";
            insertJobLog({
              jobId,
              url: firm.websiteUrl,
              companyName: firm.companyName,
              status: logStatus,
              fieldsTotal: stats.fieldsTotal,
              fieldsFilled: stats.fieldsFilled,
              emptyFields: JSON.stringify(stats.emptyFields),
              durationMs: Date.now() - startMs,
            }).catch(() => {});
          }
        } catch (err) {
          // FIX: Propagate JOB_CANCELLED so the outer loop can drain the queue
          if (err instanceof Error && err.message === 'JOB_CANCELLED') {
            firmQueue.length = 0;
            break;
          }
          // Truncate axios/network errors to avoid dumping full request/response objects in logs
          const errMsg = err instanceof Error ? err.message : String(err);
          const isAxiosErr = (err as any)?.isAxiosError || (err as any)?.response?.status;
          if (isAxiosErr) {
            const status = (err as any)?.response?.status ?? 'unknown';
            console.error(`[processAgentJob] HTTP ${status} error for ${firm.websiteUrl}: ${errMsg.slice(0, 200)}`);
          } else {
            console.error(`[processAgentJob] Error processing ${firm.websiteUrl}: ${errMsg.slice(0, 500)}`);
          }
          insertJobLog({
            jobId,
            url: firm.websiteUrl,
            companyName: firm.companyName,
            status: "failed",
            errorReason: classifyAgentError(err),
            errorDetail: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
            durationMs: Date.now() - startMs,
          }).catch(() => {});
          // Add empty row on error so we don't lose the firm from the output
          const emptyRow: Record<string, string> = {
            "Company Name": firm.companyName,
            "Website": firm.websiteUrl,
          };
          for (const s of sections) emptyRow[s.key] = "";
          profileResults.push(emptyRow);
        }

        processed++;
        await incrementJobProcessedCountSafely(jobId);
        await updateJobProgressSafely(jobId, {
          currentFirmName: firm.companyName,
          activeFirmsJson: null,
        });
      }
    };

    await Promise.allSettled(
      Array.from({ length: Math.min(CONCURRENCY, firms.length) }, runWorker),
    );

    // FIX: If the job was cancelled, skip writing the completed status.
    // The cancelJob mutation already set status = "cancelled" in the DB.
    if (isJobCancelled(jobId)) {
      console.log(`[processAgentJob] Job ${jobId} was cancelled — skipping completed update`);
      return;
    }

    // Generate output Excel and upload to S3
    const excelBuffer = createAgentOutputExcel(sections, profileResults, collectedUrls);
    const outputKey = `enrichment/${job.userId}/${jobId}-results.xlsx`;
    const { url: outputUrl } = await storagePut(
      outputKey,
      excelBuffer,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    await updateEnrichmentJob(jobId, {
      status: "completed",
      outputFileUrl: outputUrl,
      outputFileKey: outputKey,
      processedCount: processed,
      completedAt: new Date(),
    });

    console.log(
      `[processAgentJob] ✅ Job ${jobId} complete. ${profileResults.length} profiles + ${collectedUrls.length} directory entries.`,
    );
  } catch (error) {
    if (isJobCancelled(jobId)) {
      console.log(`[processAgentJob] Job ${jobId} cancelled (caught during shutdown)`);
      return;
    }
    console.error(`[processAgentJob] Job ${jobId} failed:`, error);
    await updateEnrichmentJob(jobId, {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  } finally {
    keepAlive.stop();
  }
}

export type AppRouter = typeof appRouter;
