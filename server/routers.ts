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
import { parseInputExcel, parseInputHeaders, createOutputExcel, createAgentOutputExcel, type EnrichedVCData, type TeamMemberData, type PortfolioCompanyData, type ProcessingSummaryData, type FileHeaders, type InputQualityReport } from "./excelProcessor";
import { scrapeUrl, scrapeUrlAsDirectory, type AgentSection, type DirectoryEntry as AgentDirectoryEntry, type ScrapeStats, type FieldResultMap } from "./agentScraper";
import type { SkillContext } from "../shared/skillContext";
import { generateInvestmentThesisSummaries } from "./investmentThesisAnalyzer";
import { generateResultsFile } from "./generateResultsService";
import { createCSVExport } from "./csvExporter";
import { updateJobProgressSafely, incrementJobProcessedCountSafely } from "./batchProcessor";
import { ConnectionKeepAlive } from "./dbConnectionManager";
import { isJobCancelled, isJobPaused, markJobCancelled } from "./_core/jobCancellation";
import { VCEnrichmentService } from "./vcEnrichment";
import { getOpenAIStats } from "./_core/openaiLLM";
import { queuedLLMCall } from "./_core/llmQueue";
import { classifyDecisionMakerTier } from './decisionMakerTiers';
import { calculateRecencyScore } from './portfolioIntelligence';
import { canResumeJob, prepareJobForResume, getResumeProgress } from "./resumeJob";
import { extractDirectory } from "./directoryExtractor";
import { webSearch } from "./_core/webSearch";
import { getProfile } from "./agentConfig";
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
          const costEstimate = estimateEnrichmentCost(firms.length, 6, avgDescLength);

          const qr = (firms as any).qualityReport as InputQualityReport | undefined;
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
            qualityReport: qr ?? { valid: firms.length, duplicatesRemoved: 0, malformedUrls: 0, missingCompanyNames: 0 },
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
        const costEstimate = estimateEnrichmentCost(entries.length, 6, 200);

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
          skillContextJson: z.string().optional(),
          // Column mapping (for non-standard column names)
          columnMapping: z.object({
            companyNameColumn: z.string().optional(),
            websiteUrlColumn: z.string(),
            descriptionColumn: z.string().optional(),
          }).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        // Compute cost estimate (using section count + description length for accuracy)
        const avgDescLen = input.avgDescriptionLength ?? 200;
        let sectionCount = 6;
        try {
          if (input.sectionsJson) sectionCount = (JSON.parse(input.sectionsJson) as unknown[]).length || 6;
        } catch { /* default to 6 */ }
        const estimate = estimateEnrichmentCost(input.firmCount, sectionCount, avgDescLen);

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
          // Store numeric midpoint in estimatedCostUSD (DECIMAL column) and range in two separate columns.
          // Drizzle maps decimal() columns to string in TypeScript — convert explicitly.
          estimatedCostUSD: String(((estimate.totalCostLow + estimate.totalCostHigh) / 2).toFixed(4)),
          estimatedCostLow: String(estimate.totalCostLow.toFixed(4)),
          estimatedCostHigh: String(estimate.totalCostHigh.toFixed(4)),
          sectionsJson: input.sectionsJson,
          systemPrompt: input.systemPrompt,
          objective: input.objective,
          skillContextJson: input.skillContextJson,
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
      .input(z.object({
        description: z.string().min(5),
        targetingBrief: z.object({
          outreachGoal:     z.string(),
          icpSummary:       z.string(),
          targetTitles:     z.string(),
          fitSignals:       z.string(),
          exclusionSignals: z.string(),
        }).optional(),
      }))
      .mutation(async ({ input }) => {
        // IMPORTANT: Do NOT use queuedLLMCall here.
        // When a large job is running, the LLM queue is saturated and this
        // interactive call would wait minutes before being dispatched, causing
        // a 429 RESOURCE_EXHAUSTED timeout on the HTTP request.
        // Instead, call invokeLLM directly with our own retry loop.
        const { invokeLLM } = await import("./_core/openaiLLM");

        const systemMsg = `You are a senior data extraction architect. Your job is to convert a user's plain-English data request into a precise, idiot-proof extraction plan that an AI agent will follow autonomously across hundreds or thousands of web pages — with NO human review in the loop.

The plan must be so specific and unambiguous that:
1. A junior analyst reading the section descriptions would know exactly what to look for and what to exclude
2. The AI agent never has to guess what the user meant
3. The output columns are immediately usable in a CRM or spreadsheet without post-processing
4. Edge cases (multiple people, missing data, ambiguous titles) are handled by explicit rules in the section descriptions

━━━ RULES FOR SECTIONS ━━━
- 3-10 sections total (use as many as needed to capture all requested data cleanly)
- Each section key: snake_case, max 40 chars, no spaces
- Each section label: 2-5 words, clean CSV column header (e.g. "CEO Name", "Company Website", "Tech Score")
- Each section desc: 2-4 sentences that specify:
    a) WHAT exactly to extract (be specific about format: full name, domain only, 0-100 score, etc.)
    b) WHERE to look (which page types, which HTML sections)
    c) WHAT TO EXCLUDE (common false positives: client names, testimonial authors, partner logos)
    d) WHAT TO DO when not found (return empty string, never guess or infer)
- If the user asks for "decision makers" or "contacts", split into separate Name and Title columns
- If the user asks for a score or rating, define the scoring rubric explicitly in the desc
- If the user asks for a list (e.g. "services"), specify the format (comma-separated, max N items)

━━━ RULES FOR systemPrompt ━━━
The systemPrompt is injected verbatim into every LLM extraction call. It must:
- Open with: "You are a precise data extraction specialist. Extract the following fields for {companyName} ({websiteUrl}) from the page content provided."
- List every field with its exact extraction rule, numbered and bolded
- Include explicit anti-hallucination rules: "If a field is not found, return an empty string. NEVER infer, guess, or fabricate values."
- Include source-awareness rules: "Ignore client testimonials, case study clients, partner logos, reviewer names, and any third-party content. Only extract data about the company being profiled."
- For contact/people fields: include the decision-maker priority hierarchy relevant to the user's use case
- For scoring fields: include the exact rubric with examples
- End with: "Return only what is explicitly stated on the page. Empty string is always better than a wrong answer."

━━━ RULES FOR skillContext ━━━
Infer the following from the user's description. These are used to calibrate the agent's navigation and extraction for every company in the job:
- icpSummary: One sentence describing the ideal target company (industry, size, stage, geography)
- fitSignals: 2-4 observable signals ON THE WEBSITE that indicate a good match (e.g. "SaaS pricing page visible", "active engineering team > 5 people", "Series A-B funding mentioned")
- exclusionSignals: 2-4 observable signals that mean the company should be deprioritized or skipped (e.g. "agency or consultancy", "less than 10 employees", "crypto/web3 focus")
- targetTitles: 3-6 job titles most likely to be the right decision maker FOR THIS SPECIFIC USE CASE in priority order. Be specific to the domain — don't default to "CEO" if a more relevant role exists.
- outreachGoal: One sentence explaining WHY these companies are being researched and what action will follow

━━━ RETURN FORMAT ━━━
Return ONLY valid JSON (no markdown, no code fences):
{
  "objective": "one precise sentence: what company data to find and why",
  "sections": [{"key":"snake_case_key","label":"Column Header","desc":"2-4 sentence extraction instruction with what/where/exclude/fallback"}],
  "systemPrompt": "Complete multi-paragraph extraction prompt as described above. Must be at least 300 words.",
  "skillContext": {
    "icpSummary": "...",
    "fitSignals": ["..."],
    "exclusionSignals": ["..."],
    "targetTitles": ["..."],
    "outreachGoal": "..."
  }
}`;

        // Retry up to 4 times with exponential backoff on 429
        const callWithRetry = async () => {
          for (let attempt = 0; attempt < 4; attempt++) {
            try {
              const tb = input.targetingBrief;
              const targetingBlock = tb && (tb.outreachGoal || tb.icpSummary || tb.targetTitles || tb.fitSignals || tb.exclusionSignals)
                ? `TARGETING CONTEXT (provided by user — treat as ground truth, do not override):
  Goal: ${tb.outreachGoal}
  Target companies: ${tb.icpSummary}
  Decision makers to find: ${tb.targetTitles}
  Fit signals: ${tb.fitSignals}
  Skip if: ${tb.exclusionSignals}

Generate sections calibrated to this targeting context. Include dedicated columns for the decision maker titles listed. Do NOT generate a fit_assessment column — it will be injected server-side. Do NOT generate generic sections when specific targeting criteria are provided.

USER REQUEST:
`
                : "";
              return await invokeLLM({
                messages: [
                  { role: "system", content: systemMsg },
                  { role: "user", content: targetingBlock + input.description.trim() },
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
                        skillContext: {
                          type: "object",
                          properties: {
                            icpSummary: { type: "string" },
                            fitSignals: { type: "array", items: { type: "string" } },
                            exclusionSignals: { type: "array", items: { type: "string" } },
                            targetTitles: { type: "array", items: { type: "string" } },
                            outreachGoal: { type: "string" },
                          },
                          required: ["icpSummary", "fitSignals", "exclusionSignals", "targetTitles", "outreachGoal"],
                          additionalProperties: false,
                        },
                      },
                      required: ["objective", "sections", "systemPrompt", "skillContext"],
                      additionalProperties: false,
                    },
                  },
                },
              });
            } catch (err: any) {
              const is429 =
                err?.message?.includes("429") ||
                err?.message?.includes("RESOURCE_EXHAUSTED");
              if (is429 && attempt < 3) {
                const backoffMs = Math.min(30_000, Math.pow(2, attempt) * 2000);
                console.warn(
                  `[generateExtractionPlan] 429 rate limit — retry ${attempt + 1}/3 in ${Math.ceil(backoffMs / 1000)}s`,
                );
                await new Promise(r => setTimeout(r, backoffMs));
              } else {
                throw err;
              }
            }
          }
          throw new Error("LLM call failed after retries");
        };

        try {
          const response = await callWithRetry();

          const raw = response!.choices[0]?.message?.content ?? "{}";
          const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");

          // Validate + clean sections
          let sections: AgentSection[] = (parsed.sections ?? [])
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

          // Auto-inject fit_assessment when targeting signals were provided
          const tb = input.targetingBrief;
          if (tb && (tb.fitSignals.trim() || tb.exclusionSignals.trim())) {
            const fitDesc = [
              `Score as exactly one of: "Strong Fit", "Possible Fit", or "Skip". Apply criteria in this priority order — stop at the first match.`,
              tb.exclusionSignals.trim()
                ? `1. Skip — if the company shows ANY of these signals: ${tb.exclusionSignals}.`
                : `1. Skip — if the company shows clear misalignment with the ICP.`,
              tb.fitSignals.trim()
                ? `2. Strong Fit — if the company clearly shows most of these signals: ${tb.fitSignals}.`
                : `2. Strong Fit — if the company shows strong alignment with the ICP.`,
              `3. Possible Fit — otherwise (matches ICP but missing strong-fit signals, or insufficient evidence on the page).`,
              `Base this solely on visible website content. Return exactly one value.`,
            ].join(" ");
            sections = [
              { key: "fit_assessment", label: "Fit Assessment", desc: fitDesc },
              ...sections.filter((s: AgentSection) => s.key !== "fit_assessment"),
            ];
          }

          // Build skillContext: user-provided values take precedence over LLM inference
          const parsedSC = parsed.skillContext ?? {};
          const skillContext = {
            icpSummary:       tb?.icpSummary       || parsedSC.icpSummary       || "",
            fitSignals:       tb?.fitSignals        ? tb.fitSignals.split(",").map((s: string) => s.trim()).filter(Boolean)        : (parsedSC.fitSignals        ?? []),
            exclusionSignals: tb?.exclusionSignals  ? tb.exclusionSignals.split(",").map((s: string) => s.trim()).filter(Boolean)  : (parsedSC.exclusionSignals  ?? []),
            targetTitles:     tb?.targetTitles      ? tb.targetTitles.split(",").map((s: string) => s.trim()).filter(Boolean)      : (parsedSC.targetTitles      ?? []),
            outreachGoal:     tb?.outreachGoal      || parsedSC.outreachGoal     || "",
          };

          return {
            objective: String(parsed.objective ?? input.description),
            sections,
            systemPrompt: String(parsed.systemPrompt ?? ""),
            skillContext,
          };
        } catch (err: any) {
          if (err instanceof TRPCError) throw err;
          const msg = err?.message ?? "Unknown error";
          const is429 = msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED");
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: is429
              ? `LLM rate limit hit. The system is processing a large job — please try again in 30 seconds.`
              : `Generation failed: ${msg}`,
          });
        }
      }),

    // Conversational job configurator — Claude Sonnet guides the user through
    // 2-3 questions and auto-triggers plan generation when ready.
    configureBrief: protectedProcedure
      .input(z.object({
        messages: z.array(z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string(),
        })).min(1),
      }))
      .mutation(async ({ input }) => {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "ANTHROPIC_API_KEY is not configured" });
        }
        const Anthropic = (await import("@anthropic-ai/sdk")).default;
        const client = new Anthropic({ apiKey });

        const systemPrompt = `You are a B2B data targeting expert helping configure a web scraping job.
Your goal: have a short, natural conversation (2–3 turns) to understand exactly what the user needs.

CONVERSATION FLOW:
1. First user message: Acknowledge what they said, then ask the ONE most important clarifying question. Choose from:
   - "What specific data do you want pulled from each website?" (if not stated)
   - "Who is the decision-maker you want to reach?" (if contacts are needed but titles unclear)
   - "What will you do with the data — outreach, research, or something else?" (if purpose is unclear)
   - "Any types of companies to skip?" (if exclusions would improve fit)
   Ask only one question. Keep your message to 2–3 sentences. Set readyToGenerate to false.

2. Second user message: You now have enough. Set readyToGenerate to true.
   Confirm what you understood in 1–2 sentences ending with "Generating your plan now."

3. If the very first message already covers company type + purpose + desired data clearly: set readyToGenerate true immediately, don't ask questions they already answered.

4. After 3 user messages: always set readyToGenerate true.

Always call the submit_brief tool — it is your only way to respond.`;

        // Anthropic requires messages to start with a user turn — drop any leading assistant messages
        const firstUserIdx = input.messages.findIndex(m => m.role === "user");
        const apiMessages = input.messages
          .slice(firstUserIdx)
          .map(m => ({ role: m.role, content: m.content }));

        const briefTool = {
          name: "submit_brief",
          description: "Submit your conversational response and the current targeting brief configuration.",
          input_schema: {
            type: "object" as const,
            properties: {
              message: { type: "string", description: "Your conversational reply to show the user (2–3 sentences max)" },
              readyToGenerate: { type: "boolean", description: "True when you have enough info to generate the extraction plan" },
              brief: {
                type: "object",
                properties: {
                  outreachGoal:     { type: "string", description: "What the user will do with the data" },
                  icpSummary:       { type: "string", description: "Specific company type, industry, and size" },
                  targetTitles:     { type: "string", description: "Comma-separated decision-maker job titles (blank if contacts not needed)" },
                  fitSignals:       { type: "string", description: "Comma-separated signals that indicate a strong fit" },
                  exclusionSignals: { type: "string", description: "Comma-separated signals to exclude a company" },
                  description:      { type: "string", description: "Detailed list of every data field to extract from each website" },
                },
                required: ["outreachGoal", "icpSummary", "targetTitles", "fitSignals", "exclusionSignals", "description"],
              },
            },
            required: ["message", "readyToGenerate", "brief"],
          },
        };

        let toolInput: any;
        try {
          const response = await client.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 1024,
            system: systemPrompt,
            tools: [briefTool],
            tool_choice: { type: "tool", name: "submit_brief" },
            messages: apiMessages,
          });
          const toolUse = response.content.find((b) => b.type === "tool_use");
          if (!toolUse || toolUse.type !== "tool_use") throw new Error("Claude did not call submit_brief tool");
          toolInput = (toolUse as any).input;
        } catch (err: any) {
          const status = err?.status ?? err?.statusCode ?? "?";
          const body = err?.message ?? String(err);
          console.error(`[configureBrief] Anthropic API error (${status}):`, body);
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `AI service error (${status}): ${body.slice(0, 200)}`,
          });
        }

        // Fall back to the last user message if Claude left description blank
        const lastUserMessage = input.messages.filter(m => m.role === "user").at(-1)?.content ?? "";
        const description = String(toolInput.brief?.description ?? "") || lastUserMessage;

        return {
          message:         String(toolInput.message         ?? "Got it — generating your plan now."),
          readyToGenerate: Boolean(toolInput.readyToGenerate),
          brief: {
            outreachGoal:     String(toolInput.brief?.outreachGoal     ?? ""),
            icpSummary:       String(toolInput.brief?.icpSummary       ?? ""),
            targetTitles:     String(toolInput.brief?.targetTitles     ?? ""),
            fitSignals:       String(toolInput.brief?.fitSignals       ?? ""),
            exclusionSignals: String(toolInput.brief?.exclusionSignals ?? ""),
            description,
          },
        };
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

        // Prepare job for resume (sets status back to "pending")
        await prepareJobForResume(input.jobId);

        // Restart processing — agent jobs use processAgentJob, VC jobs use processEnrichmentJob
        if (job.sectionsJson) {
          processAgentJob(input.jobId).catch((error) => {
            console.error(`Error resuming agent job ${input.jobId}:`, error);
          });
        } else {
          processEnrichmentJob(input.jobId).catch((error) => {
            console.error(`Error resuming job ${input.jobId}:`, error);
          });
        }

        const progress = await getResumeProgress(input.jobId);
        return {
          message: "Job resumed successfully",
          ...progress,
        };
      }),

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
        // Write paused status to DB. The worker's cancellation poller (every 5s)
        // will detect this and call markJobPaused(jobId), which causes
        // processAgentJob to break cleanly and save partial results to S3.
        await updateEnrichmentJob(input.jobId, { status: "paused" });
        console.log(`[pauseJob] Job ${input.jobId} marked as paused in DB`);
        return { message: "Job pause requested — worker will stop within 5 seconds" };
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
        // Works for completed, paused, and in-progress jobs (partial file saved every 5 firms).
        if (job.sectionsJson) {
          if (!job.outputFileKey) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: job.status === "processing"
                ? "Results not available yet — check back after 5 firms have been processed"
                : "No results file available for this job",
            });
          }
          const { url } = await storageGet(job.outputFileKey);
          const response = await fetch(url);
          if (!response.ok) {
            throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Results file not available in storage" });
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          const isPartial = job.status !== "completed";
          return {
            success: true,
            fileData: buffer.toString("base64"),
            fileName: isPartial
              ? `agent-results-${input.jobId}-partial.xlsx`
              : `agent-results-${input.jobId}.xlsx`,
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
          console.error(`[Job ${jobId}] Error enriching "${firm.companyName}":`, err);
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
  try {
    const job = await getEnrichmentJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    await updateEnrichmentJob(jobId, { status: "processing", startedAt: new Date() });
    // Capture LLM stats baseline so we only count tokens used by THIS job
    const statsBaseline = getOpenAIStats();
    const costBaseline   = statsBaseline.totalCost;
    const inputBaseline  = statsBaseline.totalInputTokens;
    const outputBaseline = statsBaseline.totalOutputTokens;

    const sections: AgentSection[] = JSON.parse(job.sectionsJson ?? "[]");
    const systemPrompt = job.systemPrompt ?? "";
    const objective = job.objective ?? "";
    const skillContext = job.skillContextJson ? JSON.parse(job.skillContextJson) : null;

    const columnMapping = job.columnMappingJson ? JSON.parse(job.columnMappingJson) : undefined;
    const firms = await parseInputExcel(job.inputFileUrl, columnMapping);
    console.log(`[processAgentJob] Job ${jobId}: ${firms.length} URLs, ${sections.length} sections`);

    let profileResults: Array<Record<string, string>> = [];
    let fieldResultsMapArr: Array<{ companyName: string; websiteUrl: string; fieldResults: import("./agentScraper").FieldResultMap }> = [];
    const collectedUrls: AgentDirectoryEntry[] = [];

    // Resume support: skip firms already processed in a prior run (paused/failed).
    // processedCount is incremented after every firm so it's a reliable checkpoint.
    const resumeFrom = job.processedCount ?? 0;
    let processed = resumeFrom;

    // ── CHECKPOINT RECOVERY ──────────────────────────────────────────────────
    // On resume, try to load saved intermediate results from the JSON checkpoint.
    // This avoids re-running the Excel export from scratch on resume and preserves
    // all previously extracted data (field results + profile data) exactly.
    if (resumeFrom > 0) {
      console.log(`[processAgentJob] Resuming from firm ${resumeFrom + 1} (${firms.length - resumeFrom} remaining)`);
      try {
        const checkpointKey = `enrichment/${job.userId}/${jobId}-checkpoint.json`;
        const { url: checkpointUrl } = await storageGet(checkpointKey);
        const checkpointResp = await fetch(checkpointUrl);
        if (checkpointResp.ok) {
          const checkpoint = await checkpointResp.json() as {
            profileResults: Array<Record<string, string>>;
            fieldResultsMapArr: Array<{ companyName: string; websiteUrl: string; fieldResults: import("./agentScraper").FieldResultMap }>;
          };
          profileResults = checkpoint.profileResults ?? [];
          fieldResultsMapArr = checkpoint.fieldResultsMapArr ?? [];
          console.log(`[processAgentJob] ✅ Loaded checkpoint: ${profileResults.length} profiles, ${fieldResultsMapArr.length} field results`);
        }
      } catch {
        console.log(`[processAgentJob] No checkpoint found — resuming with empty results (processed firms will be re-exported)`);
      }
    }

    // Hard cap: never process more firms than the original input file contained.
    // Directory expansion is disabled for profile-enrichment jobs — it was the
    // root cause of the job going past 100% (2000+ firms from a 1787-firm file).
    const MAX_TOTAL_ENTRIES = firms.length; // NO expansion beyond original input
    const seenUrls = new Set<string>(firms.map(f => f.websiteUrl));
    let totalQueued = firms.length;

    // Concurrency auto-scales with LLM_RPM_LIMIT.
    // Formula: floor(RPM / 7 LLM-calls-per-firm / 2) capped at 200
    // At 8000 RPM (OpenAI Tier 4 default): floor(8000 / 7 / 2) = 571 → capped at 200
    // At 800 RPM: floor(800 / 7 / 2) = 57
    // At 300 RPM: floor(300 / 7 / 2) = 21
    // Default matches costEstimation.ts (8000) and llmQueue.ts (8000).
    const RPM = parseInt(process.env.LLM_RPM_LIMIT ?? '8000', 10);
    // Tier 5 OpenAI allows 30,000 RPM. At 24,000 RPM (80% of limit), this formula
    // yields ~857 — capped at 200 to stay within Railway memory limits.
    const CONCURRENCY = Math.min(200, Math.max(5, Math.floor(RPM / 7 / 2)));
    const firmQueue = [...firms.slice(resumeFrom)];
    const originalColumns = firms[0] ? Object.keys(firms[0].originalRow) : [];
    // Track original input position so concurrent workers don't scramble row order
    const firmIndexMap = new Map(firms.map((f, i) => [f.websiteUrl, i]));

    keepAlive.start();

    const savePartialResults = async () => {
      try {
        // Save Excel for user download
        const partialBuffer = createAgentOutputExcel(sections, profileResults, collectedUrls, fieldResultsMapArr, originalColumns);
        const partialKey = `enrichment/${job.userId}/${jobId}-results.xlsx`;
        const { url: partialUrl } = await storagePut(partialKey, partialBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        await updateEnrichmentJob(jobId, { outputFileKey: partialKey, outputFileUrl: partialUrl });

        // Save JSON checkpoint for crash recovery — contains the raw data needed
        // to resume without re-extracting. Decoupled from the Excel formatting.
        const checkpointData = JSON.stringify({
          profileResults,
          fieldResultsMapArr,
          savedAt: new Date().toISOString(),
          processedCount: processed,
        });
        const checkpointKey = `enrichment/${job.userId}/${jobId}-checkpoint.json`;
        await storagePut(checkpointKey, checkpointData, "application/json");
      } catch (err) {
        console.warn(`[processAgentJob] Partial save failed (non-fatal):`, err);
      }
    };

    const runWorker = async () => {
      while (firmQueue.length > 0) {
        // Check pause/cancel at the top of every iteration — stops cleanly without
        // adding empty rows for unprocessed firms.
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

        // Per-firm wall-clock timeout — prevents a stalled fetch or runaway
        // agent loop from blocking the entire worker queue indefinitely.
        // 5 minutes is generous: a 7-hop job with 45s Puppeteer fallbacks takes ~3.5 min max.
        const FIRM_TIMEOUT_MS = 5 * 60 * 1000;
        try {
          // ── Scrape website for all sections ─────────────────────────────────
          let profileData: Record<string, string> = {};
          let fieldResultsForRow: FieldResultMap | undefined;
          let stats: ScrapeStats = { fieldsTotal: sections.length, fieldsFilled: 0, emptyFields: [] };
          let isDirectoryResult = false;

          const scrapePromise = scrapeUrl(
            firm.websiteUrl,
            rowObjective,
            sections,
            resolvedPrompt,
            getProfile().maxHops,
            () => isJobCancelled(jobId),
            undefined, // callbacks
            skillContext,
            undefined, // initialFieldValues
            firm.companyName, // knownCompanyName — passed explicitly so web searches use the real name
          );
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`FIRM_TIMEOUT: ${firm.websiteUrl} exceeded ${FIRM_TIMEOUT_MS / 1000}s`)), FIRM_TIMEOUT_MS)
          );
          const scrapeResult = await Promise.race([scrapePromise, timeoutPromise]);

          if (scrapeResult.type === "directory") {
            console.warn(`[processAgentJob] Unexpected directory result for ${firm.websiteUrl} — skipping`);
            insertJobLog({ jobId, url: firm.websiteUrl, companyName: firm.companyName, status: "failed", fieldsTotal: 0, fieldsFilled: 0, durationMs: Date.now() - startMs }).catch(() => {});
            isDirectoryResult = true;
          } else {
            profileData = scrapeResult.data;
            fieldResultsForRow = scrapeResult.fieldResults;
            stats = scrapeResult.stats;
          }

          if (!isDirectoryResult) {
            profileResults.push({ ...profileData, ...firm.originalRow, __inputIndex: String(firmIndexMap.get(firm.websiteUrl) ?? 999999) });

            if (fieldResultsForRow) {
              fieldResultsMapArr.push({ companyName: firm.companyName, websiteUrl: firm.websiteUrl, fieldResults: fieldResultsForRow });
            }

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
          console.error(`[processAgentJob] Error processing ${firm.websiteUrl}:`, err);
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
          const emptyRow: Record<string, string> = {};
          for (const s of sections) emptyRow[s.key] = "";
          profileResults.push({ ...emptyRow, ...firm.originalRow });
        }

        processed++;
        await incrementJobProcessedCountSafely(jobId);

        // Save partial results + JSON checkpoint to S3 every 3 firms so users can
        // export while the job runs AND the job can resume from the exact state on crash.
        // Fire-and-forget — failure is non-fatal; the final save at job end is authoritative.
        if (processed % 3 === 0) savePartialResults().catch(() => {});

        // Update live cost in DB every 25 firms so dashboard shows running spend
        const currentStats = getOpenAIStats();
        const liveCost = Math.round((currentStats.totalCost - costBaseline) * 10000) / 10000;
        await updateJobProgressSafely(jobId, {
          currentFirmName: firm.companyName,
          activeFirmsJson: null,
          totalCostUSD: liveCost,
          totalInputTokens:  currentStats.totalInputTokens  - inputBaseline,
          totalOutputTokens: currentStats.totalOutputTokens - outputBaseline,
        });

        // Cost safety cap: if actual spend exceeds 5x the original estimate, stop the job.
        // Raised from 3x — estimates have ±60% documented variance; complex sites legitimately
        // run 4x the estimate (JS-heavy pages, many hops). 3x was killing valid jobs.
        const estimatedCost = typeof job.estimatedCostUSD === 'string' ? parseFloat(job.estimatedCostUSD) : (job.estimatedCostUSD ?? 0);
        const costCap = Math.max(estimatedCost * 5, 10); // at least $10 cap
        if (liveCost > costCap) {
          console.warn(`[processAgentJob] 🛑 Cost cap hit: $${liveCost.toFixed(2)} > $${costCap.toFixed(2)} cap. Stopping job to prevent runaway spend.`);
          markJobCancelled(jobId);
          firmQueue.length = 0; // drain queue so other workers stop too
          break;
        }
      }
    };

    await Promise.allSettled(
      Array.from({ length: Math.min(CONCURRENCY, firms.length) }, runWorker),
    );

    // If the job was paused or cancelled, save partial results and exit without
    // marking as completed. Status is already set in DB by the mutation / poller.
    if (isJobPaused(jobId)) {
      console.log(`[processAgentJob] ⏸️ Job ${jobId} paused after ${profileResults.length} profiles. Saving partial results...`);
      profileResults.sort((a, b) => Number(a.__inputIndex ?? 0) - Number(b.__inputIndex ?? 0));
      profileResults.forEach(r => { delete r.__inputIndex; });
      await savePartialResults();
      return;
    }

    if (isJobCancelled(jobId)) {
      console.log(`[processAgentJob] 🛑 Job ${jobId} cancelled after ${profileResults.length} profiles. Saving partial results...`);
      profileResults.sort((a, b) => Number(a.__inputIndex ?? 0) - Number(b.__inputIndex ?? 0));
      profileResults.forEach(r => { delete r.__inputIndex; });
      await savePartialResults();
      return;
    }

    // Restore input row order (concurrent workers complete out-of-order)
    profileResults.sort((a, b) => Number(a.__inputIndex ?? 0) - Number(b.__inputIndex ?? 0));
    profileResults.forEach(r => { delete r.__inputIndex; });

    // Generate output Excel and upload to S3
    const excelBuffer = createAgentOutputExcel(sections, profileResults, collectedUrls, fieldResultsMapArr, originalColumns);
    const outputKey = `enrichment/${job.userId}/${jobId}-results.xlsx`;
    const { url: outputUrl } = await storagePut(
      outputKey,
      excelBuffer,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    // Write confirmed real cost to DB
    const finalStats = getOpenAIStats();
    const confirmedCost         = Math.round((finalStats.totalCost         - costBaseline)   * 10000) / 10000;
    const confirmedInputTokens  = finalStats.totalInputTokens  - inputBaseline;
    const confirmedOutputTokens = finalStats.totalOutputTokens - outputBaseline;
    console.log(`[processAgentJob] 💰 Job ${jobId} cost: $${confirmedCost.toFixed(4)} (${confirmedInputTokens} in / ${confirmedOutputTokens} out tokens)`);
    await updateEnrichmentJob(jobId, {
      status: "completed",
      outputFileUrl: outputUrl,
      outputFileKey: outputKey,
      processedCount: processed,
      completedAt: new Date(),
      totalCostUSD:       String(confirmedCost),
      totalInputTokens:   confirmedInputTokens,
      totalOutputTokens:  confirmedOutputTokens,
    });
    console.log(
      `[processAgentJob] ✅ Job ${jobId} complete. ${profileResults.length} profiles + ${collectedUrls.length} directory entries.`,
    );
  } catch (error) {
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
