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
import type { AgentSection, DirectoryEntry as AgentDirectoryEntry, ScrapeStats, ScrapeDiagnostics } from "./scraper/agentTypes";
import { scrapeUrlSuper } from "./superScraper";
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
import { scoreTeamMemberFit } from "./personFitScorer";
import { isJobCancelled, isJobPaused } from "./_core/jobCancellation";

// All agent jobs run through the super scraper (5-phase pipeline). The legacy
// agentScraper.ts / scrapeUrl path was removed.
const activeScraper = scrapeUrlSuper;

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
          // Outreach context for AI fit scoring
          outreachContext: z.string().optional(),
          targetPersona: z.string().optional(),
          exclusionCriteria: z.string().optional(),
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
          template: input.template || "b2b",
          estimatedCostUSD: String(estimate.totalCost),
          sectionsJson: input.sectionsJson,
          systemPrompt: input.systemPrompt,
          objective: input.objective,
          columnMappingJson: input.columnMapping ? JSON.stringify(input.columnMapping) : undefined,
          outreachContext: input.outreachContext,
          targetPersona: input.targetPersona,
          exclusionCriteria: input.exclusionCriteria,
        });

        // Job will be picked up by worker.ts via polling (within 5 seconds)
        // Do NOT call processAgentJob/processEnrichmentJob directly here — that causes
        // dual processing: once from this web server (no heartbeat) and again when
        // worker.ts sees it as stale and picks it up a second time.
        console.log(`[confirmAndStart] Job ${jobId} queued — worker will pick up within 5s`);

        return { jobId, firmCount: input.firmCount };
      }),

    // Quick Scrape: paste a newline-separated list of domains — no file upload needed.
    // Creates a standard enrichmentJob that the worker processes with the super scraper.
    quickScrape: protectedProcedure
      .input(
        z.object({
          domains: z.string().min(1),  // newline or comma-separated domain list
          objective: z.string().optional(),
          systemPrompt: z.string().optional(),
          sectionsJson: z.string().optional(),
          // Outreach context for AI fit scoring
          outreachContext: z.string().optional(),
          targetPersona: z.string().optional(),
          exclusionCriteria: z.string().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        // Parse and normalise the domain list
        const rawLines = input.domains.split(/[\n,;]+/).map((l: string) => l.trim()).filter(Boolean);
        const domains: string[] = [];
        for (const line of rawLines) {
          const clean = line.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim();
          if (clean && clean.includes(".")) domains.push(clean);
        }
        if (domains.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "No valid domains found in input" });
        }

        // Build a minimal CSV that the worker's parseInputExcel can read
        const csvHeader = "Company Name,Website URL";
        const csvRows = domains.map((d: string) => `"${d}","https://${d}"`).join("\n");
        const csv = `${csvHeader}\n${csvRows}\n`;

        // Upload the CSV to S3 so the worker can read it
        const fileKey = `enrichment/${ctx.user.id}/${nanoid()}-quick-scrape.csv`;
        const stored = await storagePut(fileKey, Buffer.from(csv, "utf-8"), "text/csv");
        const costEstimate = estimateEnrichmentCost(domains.length, 200);

        // Default sections for quick scrape (decision maker extraction)
        const defaultSections = JSON.stringify([
          { key: "decision_maker_name",  label: "Decision Maker Name",  desc: "Full name of the primary decision maker, CEO, founder, or owner." },
          { key: "decision_maker_title", label: "Title / Role",         desc: "Job title or role of the decision maker." },
          { key: "decision_maker_email", label: "Email",                desc: "Direct email address of the decision maker." },
          { key: "linkedin_url",         label: "LinkedIn URL",         desc: "LinkedIn profile URL of the decision maker." },
          { key: "company_phone",        label: "Phone",                desc: "Main company or direct phone number." },
        ]);
        const defaultSystemPrompt = `You are a business intelligence researcher. For each company, find the primary decision maker (CEO, founder, owner, or equivalent). Extract their full name, job title, direct email address, LinkedIn profile URL, and the company phone number. Focus on the team page, about page, and contact page. Return only verified information found on the website.`;
        const defaultObjective = "Find the primary decision maker for each company: name, title, email, LinkedIn, and phone.";

        const jobId = await createEnrichmentJob({
          userId: ctx.user.id,
          status: "pending",
          inputFileUrl: stored.url,
          inputFileKey: stored.key,
          firmCount: domains.length,
          tierFilter: "all",
          deepTeamProfileScraping: true,
          maxTeamProfiles: 10,
          template: "agent",
          estimatedCostUSD: String(costEstimate.totalCost),
          sectionsJson: input.sectionsJson ?? defaultSections,
          systemPrompt: input.systemPrompt ?? defaultSystemPrompt,
          objective: input.objective ?? defaultObjective,
          columnMappingJson: JSON.stringify({ companyNameColumn: "Company Name", websiteUrlColumn: "Website URL" }),
          outreachContext: input.outreachContext,
          targetPersona: input.targetPersona,
          exclusionCriteria: input.exclusionCriteria,
        });

        console.log(`[quickScrape] Job ${jobId} queued with ${domains.length} domains — worker will pick up within 5s`);
        return { jobId, firmCount: domains.length, estimatedCost: costEstimate.totalCost };
      }),

    // Generate AI extraction plan from user description
    generateExtractionPlan: protectedProcedure
      .input(z.object({ description: z.string().min(10) }))
      .mutation(async ({ input }) => {
        const { queuedLLMCall } = await import("./_core/llmQueue");

        const systemMsg = `You are a web data extraction architect. Parse the user's intent into a structured extraction plan.

Rules for sections:
- 3-8 sections total
- Each section key: snake_case, max 40 chars
- Each section label: 2-4 words, suitable as a CSV column header
- Each section desc: 2-3 sentence research instruction. CRITICAL: preserve the user's specific criteria, examples, exclusion rules, and context in each description. Do NOT genericize — if the user mentions specific services, industries, competitor types, or exclusion criteria, those MUST appear in the relevant section desc. For judgment/analysis fields (fit assessment, service needs, competitor signals), include what evidence to look for and what counts as a positive vs negative signal.

Return ONLY valid JSON (no markdown, no code fences):
{
  "objective": "one concise sentence describing what to find",
  "sections": [{"key":"snake_case_key","label":"Display Name","desc":"Research instruction with specific criteria from user's description"}],
  "systemPrompt": "Complete extraction prompt. Start with 'You are a [role]. Extract the following fields from the provided page content:' followed by numbered **Bold** sections with instructions. Include {companyName} and {websiteUrl} as placeholders. IMPORTANT: Include the user's specific criteria, exclusion rules, and context in the prompt so the LLM knows exactly what to look for and what to exclude."
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

          return {
            objective: String(parsed.objective ?? input.description),
            sections,
            systemPrompt: String(parsed.systemPrompt ?? ""),
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

    pauseJob: protectedProcedure
      .input(z.object({ jobId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const job = await getEnrichmentJob(input.jobId);
        if (!job || job.userId !== ctx.user.id) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });
        }
        if (job.status !== "processing" && job.status !== "pending") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Cannot pause a job with status "${job.status}"`,
          });
        }
        await updateEnrichmentJob(input.jobId, { status: "paused" });
        console.log(`[pauseJob] Job ${input.jobId} marked as paused in DB`);
        return { message: "Job pause requested — worker will stop within 5 seconds" };
      }),

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

        // Prepare job for resume — sets status back to "pending".
        // The worker will pick it up within ~5 seconds (POLL_INTERVAL).
        // Do NOT invoke processAgentJob directly here — that causes dual processing
        // when the worker also claims the job.
        await prepareJobForResume(input.jobId);

        const progress = await getResumeProgress(input.jobId);
        return {
          message: "Job resumed — worker will continue within 5s",
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

        // Agent jobs (AI Custom extraction): results are stored in S3, not in enrichedFirms.
        // Also serve partial results for failed jobs that wrote a file before crashing.
        if (job.sectionsJson && job.outputFileKey) {
          const { url } = await storageGet(job.outputFileKey);
          const response = await fetch(url);
          if (!response.ok) {
            throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Results file not available in storage" });
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          const label = job.status === "failed" ? `agent-partial-results-${input.jobId}.xlsx` : `agent-results-${input.jobId}.xlsx`;
          return {
            success: true,
            fileData: buffer.toString("base64"),
            fileName: label,
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

/**
 * @deprecated The legacy hardcoded VC enrichment pipeline. All jobs now flow
 * through processAgentJob — the worker hydrates missing sectionsJson with
 * b2b defaults so even legacy jobs route generically. This stub is kept so
 * any unexpected caller fails loudly instead of silently running stale logic.
 */
export async function processEnrichmentJob(jobId: number): Promise<never> {
  const msg = `processEnrichmentJob is deprecated and no longer runs. Job ${jobId} should be routed through processAgentJob.`;
  console.error(`[processEnrichmentJob] ${msg}`);
  await updateEnrichmentJob(jobId, {
    status: "failed",
    errorMessage: msg,
  });
  throw new Error(msg);
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

  // Hoist LLM cost baselines so catch/finally can access them
  const _statsBaseline = getOpenAIStats();
  let costBaseline = _statsBaseline.totalCost;
  let inputBaseline = _statsBaseline.totalInputTokens;
  let outputBaseline = _statsBaseline.totalOutputTokens;

  try {
    const job = await getEnrichmentJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    await updateEnrichmentJob(jobId, { status: "processing", startedAt: new Date() });

    const sections: AgentSection[] = JSON.parse(job.sectionsJson ?? "[]");
    const systemPrompt = job.systemPrompt ?? "";
    const objective = job.objective ?? "";

    const columnMapping = job.columnMappingJson ? JSON.parse(job.columnMappingJson) : undefined;
    const rawFirms = await parseInputExcel(job.inputFileUrl, columnMapping);

    // Deduplicate by normalized URL — keep first occurrence
    const seenUrls = new Set<string>();
    const firms = rawFirms.filter(f => {
      const norm = f.websiteUrl.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
      if (seenUrls.has(norm)) return false;
      seenUrls.add(norm);
      return true;
    });
    if (firms.length < rawFirms.length) {
      console.log(`[processAgentJob] Deduplicated: ${rawFirms.length} → ${firms.length} unique URLs`);
    }
    console.log(`[processAgentJob] Job ${jobId}: ${firms.length} URLs, ${sections.length} sections`);

    const profileResults: Array<Record<string, string>> = [];
    const diagnosticResults: Array<{ companyName: string; websiteUrl: string; diagnostics: ScrapeDiagnostics }> = [];
    const collectedUrls: AgentDirectoryEntry[] = [];
    let processed = 0;
    // Running totals for the stats grid (updated after each firm)
    let totalEmailsFound = 0;
    let totalPeopleFound = 0;
    let totalDomainsWithData = 0;

    // Re-snapshot baselines right before processing starts (after job setup completes)
    const statsNow = getOpenAIStats();
    costBaseline = statsNow.totalCost;
    inputBaseline = statsNow.totalInputTokens;
    outputBaseline = statsNow.totalOutputTokens;

    const CONCURRENCY = 20;
    const firmQueue = [...firms];
    // Track queued URLs to prevent directory expansion from creating duplicates
    const queuedUrls = new Set(firms.map(f => f.websiteUrl));

    const runWorker = async () => {
      while (firmQueue.length > 0) {
        // Check pause/cancel at the top of every iteration
        if (isJobPaused(jobId) || isJobCancelled(jobId)) break;

        const firm = firmQueue.shift();
        if (!firm) break;

        // Use per-row objective (Description column) if present, else global objective
        const rowObjective = firm.description?.trim() || objective;
        const startMs = Date.now();

        // Substitute template variables in system prompt
        const resolvedPrompt = systemPrompt
          .replace(/\{companyName\}/g, firm.companyName)
          .replace(/\{websiteUrl\}/g, firm.websiteUrl);

        try {
          const result = await activeScraper(
            firm.websiteUrl,
            rowObjective,
            sections,
            resolvedPrompt,
            5,
            // Pause and cancel BOTH abort the in-flight scrape. The outer
            // processAgentJob check below differentiates pause (saves partial,
            // resumable) vs cancel (saves partial, terminates).
            () => isJobCancelled(jobId) || isJobPaused(jobId),
          );

          if (result.type === "directory") {
            collectedUrls.push(...result.entries);
            // Queue each discovered directory entry for individual profile scraping.
            // Without this, entries only appear on a "Collected URLs" sheet and are never
            // enriched with the user's custom sections.
            for (const entry of result.entries) {
              const scrapeTarget = entry.nativeUrl || entry.directoryUrl;
              if (scrapeTarget && scrapeTarget !== firm.websiteUrl && !queuedUrls.has(scrapeTarget)) {
                firmQueue.push({
                  companyName: entry.name || scrapeTarget,
                  websiteUrl: scrapeTarget,
                  description: rowObjective,
                });
                queuedUrls.add(scrapeTarget);
              }
            }
            console.log(`[processAgentJob] Directory expanded: ${result.entries.length} entries queued for scraping`);
            insertJobLog({ jobId, url: firm.websiteUrl, companyName: firm.companyName, status: "success", fieldsTotal: 0, fieldsFilled: 0, durationMs: Date.now() - startMs }).catch(() => {});
          } else {
            // Fit scoring for agent pipeline. Always runs — falls back to a
            // title-based heuristic when outreach context is not provided.
            try {
              // Find DM-like fields in the extracted data
              const dmFields = Object.entries(result.data).filter(([k]) =>
                /contact|decision.?maker|dm|erp|person|name/i.test(k) && !/email|phone|linkedin/i.test(k)
              );
              const dmValue = dmFields.find(([, v]) => v?.trim())?.[1] || "";
              // Extract name part (before comma/dash that indicates title)
              const namePart = dmValue.split(/[,;|–—]/).map(p => p.trim()).find(p =>
                p.split(/\s+/).length >= 2 && !p.includes("@") && !/^\d/.test(p) && !p.toLowerCase().startsWith("no ")
              );
              if (namePart && namePart.length > 2) {
                const titlePart = dmValue.replace(namePart, "").replace(/^[,;|–— ]+/, "").trim();
                const fitScores = await scoreTeamMemberFit(
                  [{ name: namePart, title: titlePart }],
                  { companyName: firm.companyName },
                  { context: job.outreachContext || "", persona: job.targetPersona || "", exclusions: job.exclusionCriteria || "" },
                );
                if (fitScores?.[0]) {
                  result.data["fit_score"] = String(fitScores[0].score);
                  result.data["buying_role"] = fitScores[0].buyingRole || "";
                  result.data["fit_reasoning"] = fitScores[0].reasoning;
                }
              }
            } catch (err) {
              console.warn(`[processAgentJob] Fit scoring failed for ${firm.companyName} (non-fatal):`, err);
            }

            profileResults.push({
              "Company Name": firm.companyName,
              "Website": firm.websiteUrl,
              ...result.data,
            });
            if (result.diagnostics) {
              diagnosticResults.push({
                companyName: firm.companyName,
                websiteUrl: firm.websiteUrl,
                diagnostics: result.diagnostics,
              });
            }

            // Save to database for queryability. The full per-template field map
            // is stored in `extractedData` (JSON). A few common keys are also mirrored
            // into typed columns so existing list/search queries still work without a
            // JSON-aware where-clause.
            try {
              const db = await (await import("./db")).getDb();
              if (db) {
                const { enrichedFirms } = await import("../drizzle/schema");
                await db.insert(enrichedFirms).values({
                  jobId,
                  companyName: firm.companyName,
                  websiteUrl: firm.websiteUrl,
                  websiteVerified: "Yes",
                  // Mirror a handful of common fields into typed columns for searchability.
                  description:
                    result.data["description"] ||
                    result.data["company_overview"] ||
                    result.data["business_activities"] ||
                    result.data["business_does"] ||
                    null,
                  headquarters:
                    result.data["hq_location"] ||
                    result.data["location"] ||
                    result.data["headquarters"] ||
                    null,
                  foundedYear:
                    result.data["founded_year"] ||
                    result.data["founded"] ||
                    null,
                  // Full extracted blob — every field the agent pipeline produced.
                  extractedData: result.data,
                });
              }
            } catch (dbErr) {
              // Non-fatal — S3 Excel is the primary output
              console.warn(`[processAgentJob] DB save failed for ${firm.companyName} (non-fatal):`, dbErr);
            }

            const stats: ScrapeStats = result.stats;
            // Accumulate stats-grid counters
            totalEmailsFound += stats.emailCount ?? 0;
            totalPeopleFound += stats.personCount ?? 0;
            if (stats.hasData) totalDomainsWithData++;
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
          // If the user cancelled/paused mid-scrape, the abort signal fires and the
          // underlying fetch throws AbortError. Don't log it as a per-firm failure —
          // the outer pause/cancel handlers below will save partial results and exit.
          const errMsg = err instanceof Error ? err.message : String(err);
          const isAbort =
            (err as any)?.name === "AbortError" ||
            errMsg === "JOB_CANCELLED" ||
            isJobCancelled(jobId) ||
            isJobPaused(jobId);
          if (isAbort) {
            console.log(`[processAgentJob] Aborted mid-scrape for ${firm.websiteUrl} — pause/cancel detected`);
            // Return the firm to the front of the queue if paused so it can be
            // retried on resume; on cancel it doesn't matter.
            if (isJobPaused(jobId)) firmQueue.unshift(firm);
            break;
          }

          console.error(`[processAgentJob] Error processing ${firm.websiteUrl}:`, err);
          insertJobLog({
            jobId,
            url: firm.websiteUrl,
            companyName: firm.companyName,
            status: "failed",
            errorReason: classifyAgentError(err),
            errorDetail: errMsg.slice(0, 500),
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
        const currentStats = getOpenAIStats();
        await incrementJobProcessedCountSafely(jobId);
        await updateJobProgressSafely(jobId, {
          currentFirmName: firm.companyName,
          activeFirmsJson: null,
          emailsFound: totalEmailsFound,
          peopleFound: totalPeopleFound,
          domainsWithData: totalDomainsWithData,
          totalCostUSD: Math.round((currentStats.totalCost - costBaseline) * 10000) / 10000,
          totalInputTokens: currentStats.totalInputTokens - inputBaseline,
          totalOutputTokens: currentStats.totalOutputTokens - outputBaseline,
        });

        // Incremental save every 50 firms — crash recovery + downloadable mid-job
        if (processed % 50 === 0) {
          try {
            const partialBuffer = createAgentOutputExcel(sections, profileResults, collectedUrls, diagnosticResults);
            const partialKey = `enrichment/${job.userId}/${jobId}-results.xlsx`;
            const { url: partialUrl } = await storagePut(
              partialKey, partialBuffer,
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            );
            await updateEnrichmentJob(jobId, { outputFileUrl: partialUrl, outputFileKey: partialKey });
            console.log(`[processAgentJob] Incremental save: ${profileResults.length} profiles (${processed} processed)`);
          } catch (err) {
            console.warn(`[processAgentJob] Incremental save failed (non-fatal):`, err);
          }
        }
      }
    };

    await Promise.allSettled(
      Array.from({ length: Math.min(CONCURRENCY, firms.length) }, runWorker),
    );

    // Save partial results helper (used by both cancel and pause paths)
    const savePartialResults = async () => {
      const excelBuffer = createAgentOutputExcel(sections, profileResults, collectedUrls, diagnosticResults);
      const outputKey = `enrichment/${job.userId}/${jobId}-partial-results.xlsx`;
      const { url: outputUrl } = await storagePut(
        outputKey,
        excelBuffer,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      await updateEnrichmentJob(jobId, {
        outputFileUrl: outputUrl,
        outputFileKey: outputKey,
        processedCount: processed,
      });
      console.log(`[processAgentJob] Saved partial results: ${profileResults.length} profiles`);
    };

    // If paused or cancelled, save partial results + cost and exit
    if (isJobPaused(jobId)) {
      console.log(`[processAgentJob] ⏸️ Job ${jobId} paused after ${profileResults.length} profiles. Saving partial results...`);
      await savePartialResults();
      const pauseStats = getOpenAIStats();
      await updateEnrichmentJob(jobId, {
        totalCostUSD: String(Math.round((pauseStats.totalCost - costBaseline) * 10000) / 10000),
        totalInputTokens: pauseStats.totalInputTokens - inputBaseline,
        totalOutputTokens: pauseStats.totalOutputTokens - outputBaseline,
      });
      return;
    }

    if (isJobCancelled(jobId)) {
      console.log(`[processAgentJob] 🛑 Job ${jobId} cancelled after ${profileResults.length} profiles. Saving partial results...`);
      await savePartialResults();
      const cancelStats = getOpenAIStats();
      await updateEnrichmentJob(jobId, {
        totalCostUSD: String(Math.round((cancelStats.totalCost - costBaseline) * 10000) / 10000),
        totalInputTokens: cancelStats.totalInputTokens - inputBaseline,
        totalOutputTokens: cancelStats.totalOutputTokens - outputBaseline,
      });
      return;
    }

    // Generate output Excel and upload to S3
    const excelBuffer = createAgentOutputExcel(sections, profileResults, collectedUrls, diagnosticResults);
    const outputKey = `enrichment/${job.userId}/${jobId}-results.xlsx`;
    const { url: outputUrl } = await storagePut(
      outputKey,
      excelBuffer,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    // Compute job-specific LLM cost
    const finalStats = getOpenAIStats();
    const jobCost = Math.round((finalStats.totalCost - costBaseline) * 10000) / 10000;
    console.log(`[processAgentJob] LLM cost for job ${jobId}: $${jobCost}`);

    await updateEnrichmentJob(jobId, {
      status: "completed",
      outputFileUrl: outputUrl,
      outputFileKey: outputKey,
      processedCount: processed,
      completedAt: new Date(),
      totalCostUSD: String(jobCost),
      totalInputTokens: finalStats.totalInputTokens - inputBaseline,
      totalOutputTokens: finalStats.totalOutputTokens - outputBaseline,
    });

    console.log(
      `[processAgentJob] ✅ Job ${jobId} complete. ${profileResults.length} profiles + ${collectedUrls.length} directory entries. Cost: $${jobCost}`,
    );
  } catch (error) {
    console.error(`[processAgentJob] Job ${jobId} failed:`, error);
    // Still save cost even on failure
    const failStats = getOpenAIStats();
    const failCost = Math.round((failStats.totalCost - costBaseline) * 10000) / 10000;
    await updateEnrichmentJob(jobId, {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      totalCostUSD: String(failCost),
      totalInputTokens: failStats.totalInputTokens - inputBaseline,
      totalOutputTokens: failStats.totalOutputTokens - outputBaseline,
    });
  } finally {
    keepAlive.stop();
  }
}

export type AppRouter = typeof appRouter;
