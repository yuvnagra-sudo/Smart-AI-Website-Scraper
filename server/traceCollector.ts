/**
 * Trace Collector — Decision Trace Recording for Agent Observability
 *
 * Records every decision the agent makes during a scrape:
 *   - PLAN: which action was chosen and why
 *   - FETCH: which URL was fetched, success/failure, content size
 *   - EXTRACT: which fields were extracted, pre-LLM vs LLM, citation validity
 *   - MERGE: which fields changed, old vs new values, reasoning
 *
 * Data is stored in two tiers:
 *   1. DB (agentTraces table): queryable summary stats per company
 *   2. S3 (JSON file): full step-by-step trace, loaded on-demand for review
 *
 * Instantiated per-company inside scrapeUrl(). Lightweight — just pushes to
 * an in-memory array. finalize() does the I/O.
 */

import type { FieldResultMap } from "./agentScraper";

// ---------------------------------------------------------------------------
// Trace step types
// ---------------------------------------------------------------------------

export interface PlanStep {
  step: "plan";
  hop: number;
  timestamp: number;
  input: {
    weakFields: string[];
    availableLinksCount: number;
    visitedCount: number;
    hopsRemaining: number;
  };
  decision: {
    action: string;
    target?: string | null;
    query?: string | null;
    reason: string;
  };
  llm?: {
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number;
    latencyMs?: number;
  };
}

export interface FetchStep {
  step: "fetch";
  hop: number;
  timestamp: number;
  url: string;
  result: {
    success: boolean;
    source?: string;
    contentLength?: number;
    linksFound?: number;
    hasRawHtml?: boolean;
    latencyMs: number;
  };
}

export interface ExtractStep {
  step: "extract";
  hop: number;
  timestamp: number;
  sourceUrl?: string;
  pageType?: string;
  preLLMResults: Record<string, { value: string; confidence: number; method?: string }>;
  sectionsSkippedByPreLLM: string[];
  sectionsSentToLLM: string[];
  llmResults: Record<string, { value: string; confidence: number; citationValid?: boolean; method?: string }>;
  citationFailures: string[];
  llm?: {
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number;
    latencyMs?: number;
  };
}

export interface MergeStep {
  step: "merge";
  hop: number;
  timestamp: number;
  changes: Array<{
    field: string;
    oldValue: string;
    newValue: string;
    reason: string;
  }>;
  fieldSnapshot: Record<string, { value: string; confidence: number; method?: string }>;
  fieldsConfident: number;
  fieldsTotal: number;
}

export type TraceStep = PlanStep | FetchStep | ExtractStep | MergeStep;

// ---------------------------------------------------------------------------
// Trace summary (written to DB)
// ---------------------------------------------------------------------------

export interface TraceSummary {
  firmName: string;
  websiteUrl: string;
  profileName: string;
  status: string;
  hopsUsed: number;
  maxHops: number;
  fieldsTotal: number;
  fieldsConfident: number;
  fieldsFilled: number;
  preLLMFieldsExtracted: number;
  citationFailures: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
  totalLatencyMs: number;
  needsReview: boolean;
  reviewReason: string;
}

// ---------------------------------------------------------------------------
// Trace Collector class
// ---------------------------------------------------------------------------

export class TraceCollector {
  private steps: TraceStep[] = [];
  private startTime: number;

  constructor(
    public readonly jobId: number,
    public readonly firmName: string,
    public readonly websiteUrl: string,
    public readonly profileName: string,
    public readonly maxHops: number,
  ) {
    this.startTime = Date.now();
  }

  /** Record a PLAN step (planNextAction decision). */
  recordPlan(
    hop: number,
    weakFields: string[],
    availableLinksCount: number,
    visitedCount: number,
    hopsRemaining: number,
    decision: PlanStep["decision"],
    llm?: PlanStep["llm"],
  ): void {
    this.steps.push({
      step: "plan",
      hop,
      timestamp: Date.now(),
      input: { weakFields, availableLinksCount, visitedCount, hopsRemaining },
      decision,
      llm,
    });
  }

  /** Record a FETCH step (fetchAndExtract result). */
  recordFetch(
    hop: number,
    url: string,
    result: FetchStep["result"],
  ): void {
    this.steps.push({
      step: "fetch",
      hop,
      timestamp: Date.now(),
      url,
      result,
    });
  }

  /** Record an EXTRACT step (extractProfileFields result). */
  recordExtract(
    hop: number,
    sourceUrl: string | undefined,
    pageType: string | undefined,
    preLLMResults: ExtractStep["preLLMResults"],
    sectionsSkippedByPreLLM: string[],
    sectionsSentToLLM: string[],
    llmResults: ExtractStep["llmResults"],
    citationFailures: string[],
    llm?: ExtractStep["llm"],
  ): void {
    this.steps.push({
      step: "extract",
      hop,
      timestamp: Date.now(),
      sourceUrl,
      pageType,
      preLLMResults,
      sectionsSkippedByPreLLM,
      sectionsSentToLLM,
      llmResults,
      citationFailures,
      llm,
    });
  }

  /** Record a MERGE step (mergeFieldResults changes). */
  recordMerge(
    hop: number,
    changes: MergeStep["changes"],
    fieldSnapshot: MergeStep["fieldSnapshot"],
    fieldsConfident: number,
    fieldsTotal: number,
  ): void {
    this.steps.push({
      step: "merge",
      hop,
      timestamp: Date.now(),
      changes,
      fieldSnapshot,
      fieldsConfident,
      fieldsTotal,
    });
  }

  /** Get all recorded steps. */
  getSteps(): TraceStep[] {
    return this.steps;
  }

  /**
   * Compute summary stats and determine if this trace needs human review.
   * Returns the summary + full trace JSON for storage.
   */
  finalize(
    status: string,
    fieldResults: FieldResultMap,
    hopsUsed: number,
    fieldsTotal: number,
  ): { summary: TraceSummary; traceJson: string } {
    const totalLatencyMs = Date.now() - this.startTime;

    // Compute aggregate stats from steps
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCostUsd = 0;
    let preLLMFieldsExtracted = 0;
    let citationFailures = 0;

    for (const step of this.steps) {
      if (step.step === "plan" && step.llm) {
        totalPromptTokens += step.llm.promptTokens ?? 0;
        totalCompletionTokens += step.llm.completionTokens ?? 0;
        totalCostUsd += step.llm.costUsd ?? 0;
      }
      if (step.step === "extract") {
        totalPromptTokens += step.llm?.promptTokens ?? 0;
        totalCompletionTokens += step.llm?.completionTokens ?? 0;
        totalCostUsd += step.llm?.costUsd ?? 0;
        preLLMFieldsExtracted += step.sectionsSkippedByPreLLM.length;
        citationFailures += step.citationFailures.length;
      }
    }

    // Count confident and filled fields
    const fieldsConfident = Object.values(fieldResults)
      .filter(r => r.confidence >= 0.7).length;
    const fieldsFilled = Object.values(fieldResults)
      .filter(r => r.value && r.value.trim() !== "").length;

    // Auto-review flagging
    let needsReview = false;
    let reviewReason = "";

    if (status === "error") {
      needsReview = true;
      reviewReason = "pipeline_error";
    } else if (fieldsConfident < fieldsTotal * 0.5) {
      needsReview = true;
      reviewReason = "low_confidence";
    } else if (citationFailures > 2) {
      needsReview = true;
      reviewReason = "citation_failures";
    } else if (hopsUsed >= this.maxHops) {
      needsReview = true;
      reviewReason = "hop_limit_reached";
    } else if (Math.random() < 0.05) {
      needsReview = true;
      reviewReason = "random_qa_sample";
    }

    const summary: TraceSummary = {
      firmName: this.firmName,
      websiteUrl: this.websiteUrl,
      profileName: this.profileName,
      status,
      hopsUsed,
      maxHops: this.maxHops,
      fieldsTotal,
      fieldsConfident,
      fieldsFilled,
      preLLMFieldsExtracted,
      citationFailures,
      totalPromptTokens,
      totalCompletionTokens,
      totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
      totalLatencyMs,
      needsReview,
      reviewReason,
    };

    const traceJson = JSON.stringify({
      jobId: this.jobId,
      firmName: this.firmName,
      websiteUrl: this.websiteUrl,
      profileName: this.profileName,
      summary,
      steps: this.steps,
      createdAt: new Date().toISOString(),
    });

    return { summary, traceJson };
  }
}
